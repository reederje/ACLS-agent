def test_health_endpoint_is_minimal_and_public(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json == {"status": "ok", "mode": "synthetic-prototype"}
