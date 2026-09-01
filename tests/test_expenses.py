"""GET / POST / DELETE /expenses."""

from __future__ import annotations


def test_list_returns_a_plain_array_with_the_total_in_a_header(client, seeded):
    response = client.get("/expenses", params={"page": 1, "page_size": 2})

    assert response.status_code == 200
    assert response.headers["X-Total-Count"] == "5"  # total ignores pagination
    body = response.json()
    assert isinstance(body, list)
    assert len(body) == 2
    assert set(body[0]) == {"id", "title", "amount", "category", "date", "notes"}


def test_pagination_does_not_drop_or_repeat_rows_that_tie_on_the_sort_column(client, seeded):
    """Two rows share 2026-06-10; a non-deterministic order would lose one."""
    seen: list[int] = []
    for page in (1, 2, 3):
        response = client.get(
            "/expenses", params={"page": page, "page_size": 2, "sort": "date"}
        )
        seen.extend(row["id"] for row in response.json())

    assert len(seen) == len(set(seen)) == 5


def test_sort_and_order_are_applied(client, seeded):
    amounts = [
        row["amount"]
        for row in client.get("/expenses", params={"sort": "amount", "order": "asc"}).json()
    ]
    assert amounts == sorted(amounts)


def test_unknown_sort_column_is_rejected(client, seeded):
    assert client.get("/expenses", params={"sort": "notes; drop table"}).status_code == 422


def test_filters_narrow_the_result_set(client, seeded):
    def titles(**params) -> set[str]:
        response = client.get("/expenses", params=params)
        assert response.status_code == 200
        return {row["title"] for row in response.json()}

    assert titles(category="food") == {"Lunch at Toit", "Groceries"}  # case-insensitive
    assert titles(q="TOIT") == {"Lunch at Toit"}
    assert titles(q="reimbursable") == {"Lunch at Toit"}  # q searches notes too
    assert titles(date_from="2026-06-01", date_to="2026-06-15") == {
        "Lunch at Toit",
        "Groceries",
        "Metro card top-up",
    }
    assert titles(amount_min=2000, amount_max=5000) == {"Groceries"}


def test_q_treats_like_wildcards_literally(client, seeded):
    assert client.get("/expenses", params={"q": "%"}).json() == []


def test_contradictory_ranges_are_rejected(client, seeded):
    dates = client.get("/expenses", params={"date_from": "2026-06-30", "date_to": "2026-06-01"})
    amounts = client.get("/expenses", params={"amount_min": 500, "amount_max": 100})

    assert dates.status_code == 422
    assert amounts.status_code == 422


def test_create_returns_201_and_the_row_is_listed(client):
    payload = {
        "title": "  Filter coffee  ",
        "amount": 325.50,
        "category": "Food",
        "date": "2026-06-18",
        "notes": "team catchup",
    }

    response = client.post("/expenses", json=payload)

    assert response.status_code == 201
    created = response.json()
    assert created["title"] == "Filter coffee"  # whitespace trimmed
    assert created["amount"] == 325.50
    assert created["id"] > 0

    listed = client.get("/expenses", params={"q": "filter coffee"}).json()
    assert [row["id"] for row in listed] == [created["id"]]


def test_create_rejects_invalid_amounts(client):
    def post(amount):
        return client.post(
            "/expenses", json={"title": "x", "amount": amount, "date": "2026-06-18"}
        ).status_code

    assert post(0) == 422
    assert post(-10) == 422
    assert post(1.005) == 422  # money has a 2 dp scale; we reject rather than round


def test_delete_returns_an_empty_204_then_404(client, seeded):
    expense_id = client.get("/expenses").json()[0]["id"]

    deleted = client.delete(f"/expenses/{expense_id}")
    assert deleted.status_code == 204
    assert deleted.content == b""

    assert client.delete(f"/expenses/{expense_id}").status_code == 404


def test_the_ui_mount_does_not_shadow_the_api(client, seeded):
    home = client.get("/")

    assert home.status_code == 200
    assert "<title>Expenses</title>" in home.text
    assert client.get("/expenses").status_code == 200
