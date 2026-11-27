"""Tests for POST /api/ask (the spending agent in the web app).

They use a fake model that plays back a script of tool calls, so they run in a second with no
Ollama. Everything else is real: the route, login, the read-only views and the safety checks."""
import json
from types import SimpleNamespace as NS

import httpx
import pytest
from fastapi.testclient import TestClient

import agent
from server.main import app
from tests.test_api import anon, cat, client, fresh_db  # noqa: F401  (fixtures)


def tool_call(sql, call_id="call_1"):
    fn = NS(name="run_query", arguments=json.dumps({"sql": sql}))
    return NS(choices=[NS(message=NS(content="", tool_calls=[NS(id=call_id, function=fn)], model_extra={}))])


def answer(text):
    return NS(choices=[NS(message=NS(content=text, tool_calls=None, model_extra={"reasoning": "Done."}))])


class FakeModel:
    """Stands in for the OpenAI client: each call to create() returns the next scripted reply."""
    def __init__(self, *replies):
        self.replies, self.requests = list(replies), []
        self.chat = NS(completions=NS(create=self.create))

    def create(self, **request):
        self.requests.append({**request, "messages": list(request["messages"])})  # a copy: the loop keeps appending
        return self.replies.pop(0)


@pytest.fixture()
def model(monkeypatch):
    def use(*replies):
        fake = FakeModel(*replies)
        monkeypatch.setattr(agent, "make_client", lambda *a, **k: fake)
        return fake
    return use


def events(response):
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line]


def spend(c, amount, note="Lunch"):
    k = c.post("/api/categories", json={"name": "Food", "budget": 200, "color": "#FF7A59"}).json()
    if "id" not in k:  # already exists
        k = next(x for x in c.get("/api/state").json()["cats"] if x["name"] == "Food")
    assert c.post("/api/expenses", json={"cat": k["id"], "amount": amount, "date": "2026-10-05", "note": note}).status_code == 201


def test_ask_requires_login(anon):
    assert anon.post("/api/ask", json={"question": "How much did I spend?"}).status_code == 401


def test_ask_streams_each_step_then_the_answer(client, model):
    spend(client, 12.5)
    fake = model(tool_call("SELECT ROUND(SUM(amount), 2) AS total FROM expenses"), answer("You spent $12.50."))
    ev = events(client.post("/api/ask", json={"question": "How much did I spend?"}))
    assert [e["type"] for e in ev] == ["step", "tool_call", "tool_result", "step", "thinking", "answer"]
    assert ev[1]["args"] == {"sql": "SELECT ROUND(SUM(amount), 2) AS total FROM expenses"}
    assert ev[2]["result"]["rows"] == [[12.5]]
    assert ev[-1] == {"type": "answer", "text": "You spent $12.50.", "steps": 2}
    # The tool result went back to the model, tagged with the call it answers.
    assert fake.requests[1]["messages"][-1]["role"] == "tool"
    assert fake.requests[1]["messages"][-1]["tool_call_id"] == "call_1"


def test_follow_up_questions_get_the_earlier_answers(client, model):
    fake = model(answer("And $0 in September."))
    history = [{"q": "Food in October?", "a": "You spent $12.50."}]
    events(client.post("/api/ask", json={"question": "and in September?", "history": history}))
    roles = [(m["role"], m["content"]) for m in fake.requests[0]["messages"][1:]]
    assert roles == [("user", "Food in October?"), ("assistant", "You spent $12.50."), ("user", "and in September?")]


def test_agent_only_sees_the_signed_in_account(client, model):
    spend(client, 12.5)  # me@example.com
    them = TestClient(app)
    assert them.post("/api/auth/signup", json={"email": "them@example.com", "password": "battery staple"}).status_code == 201
    spend(them, 999)

    model(tool_call("SELECT SUM(amount) FROM expenses"), answer("ok"))
    assert events(them.post("/api/ask", json={"question": "Total?"}))[2]["result"]["rows"] == [[999.0]]
    model(tool_call("SELECT SUM(amount) FROM expenses"), answer("ok"))
    assert events(client.post("/api/ask", json={"question": "Total?"}))[2]["result"]["rows"] == [[12.5]]

    # Going around the views, or at the account tables, is refused.
    for sql in ["SELECT SUM(amount) FROM main.expenses", "SELECT email FROM users", "SELECT * FROM sessions",
                "DELETE FROM expenses", "SELECT 1; DELETE FROM main.expenses"]:
        model(tool_call(sql), answer("ok"))
        assert "error" in events(client.post("/api/ask", json={"question": "?"}))[2]["result"], sql
    assert len(client.get("/api/state").json()["exps"]) == 1  # nothing was deleted


def test_ask_validates_input(client, model):
    for body in [{"question": "   "}, {"question": "x" * 501},
                 {"question": "ok", "history": [{"q": "q", "a": "a"}] * 7}]:
        assert client.post("/api/ask", json=body).status_code == 422


def test_ask_explains_when_the_model_is_not_running(client, monkeypatch):
    def down(**_):
        raise agent.APIConnectionError(request=httpx.Request("POST", "http://localhost:11434/v1"))
    monkeypatch.setattr(agent, "make_client", lambda *a, **k: NS(chat=NS(completions=NS(create=down))))
    ev = events(client.post("/api/ask", json={"question": "Total?"}))
    assert ev[-1]["type"] == "error" and "Ollama" in ev[-1]["message"]


def test_ask_refuses_cross_site_requests(client):
    r = client.post("/api/ask", json={"question": "Total?"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_a_long_earlier_answer_is_trimmed_not_refused(client, model):
    fake = model(answer("ok"))
    history = [{"q": "List every food expense", "a": "x" * 5000}]
    events(client.post("/api/ask", json={"question": "and the total?", "history": history}))
    sent = fake.requests[0]["messages"][2]["content"]
    assert len(sent) < 4100 and sent.endswith("…")


def test_odd_text_from_the_model_becomes_an_error_it_can_read(client, model):
    model(tool_call("SELECT '\ud800'"), answer("ok"))   # a lone surrogate SQLite can't encode
    ev = events(client.post("/api/ask", json={"question": "?"}))
    assert "error" in ev[2]["result"] and ev[-1]["type"] == "answer"


def test_unexpected_errors_show_a_plain_message(client, monkeypatch):
    def boom(**_):
        raise RuntimeError("/secret/path/to/ledger.db exploded")
    monkeypatch.setattr(agent, "make_client", lambda *a, **k: NS(chat=NS(completions=NS(create=boom))))
    ev = events(client.post("/api/ask", json={"question": "?"}))
    assert ev[-1]["type"] == "error" and "secret" not in ev[-1]["message"]


def test_open_database_explains_a_file_that_is_not_ledger(tmp_path):
    bad = tmp_path / "old.db"
    import sqlite3
    sqlite3.connect(bad).executescript("CREATE TABLE expenses (id INTEGER, amount REAL);")
    for path in (bad, "web/index.html"):
        with pytest.raises(agent.SetupError):
            agent.open_database(path, 1)
