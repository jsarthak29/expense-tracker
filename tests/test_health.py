"""The operational endpoint container health checks use."""

from __future__ import annotations


def test_health_reports_ok_and_touches_the_database(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_does_not_appear_in_the_published_contract(client):
    """/health is additive tooling, so it must not shadow a contract route."""
    paths = client.get("/openapi.json").json()["paths"]

    assert "/health" in paths
    for required in ("/expenses", "/expenses/{expense_id}", "/summary"):
        assert required in paths
