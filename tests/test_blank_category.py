"""The intentional quirk: rows with no category.

Policy under test - blank is stored as NULL, surfaces as "" on the wire, is
never matched by a named category filter, is reachable via ?category=__blank__,
and is counted in /summary rather than dropped.
"""

from __future__ import annotations


def test_blank_category_round_trips_as_an_empty_string(client):
    created = client.post(
        "/expenses",
        json={"title": "Cash", "amount": 100, "category": "   ", "date": "2026-06-18"},
    ).json()

    assert created["category"] == ""

    fetched = client.get("/expenses", params={"q": "Cash"}).json()
    assert fetched[0]["category"] == ""


def test_omitted_category_behaves_the_same_as_a_blank_one(client):
    created = client.post(
        "/expenses", json={"title": "Cash", "amount": 100, "date": "2026-06-18"}
    ).json()

    assert created["category"] == ""


def test_a_named_category_filter_never_matches_uncategorised_rows(client, seeded):
    titles = {row["title"] for row in client.get("/expenses", params={"category": "Food"}).json()}

    assert "Unlabelled cash withdrawal" not in titles


def test_the_reserved_filter_value_selects_exactly_the_uncategorised_rows(client, seeded):
    response = client.get("/expenses", params={"category": "__blank__"})

    assert response.headers["X-Total-Count"] == "1"
    assert [row["title"] for row in response.json()] == ["Unlabelled cash withdrawal"]


def test_an_empty_category_param_is_treated_as_no_filter(client, seeded):
    """The UI filter form submits empty strings for fields nobody touched."""
    response = client.get("/expenses", params={"category": ""})

    assert response.headers["X-Total-Count"] == "5"
