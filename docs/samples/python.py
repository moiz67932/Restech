import hashlib, hmac, json, os, time, uuid
from flask import Flask, request
import requests

path = "/v1/locations/loc_example/bills/INV-1001"
body = json.dumps({"external_table_id":"12","version":1,"currency":"PKR","status":"open","order_status":"accepted","items":[{"external_item_id":"I1","name":"Meal","quantity":1,"unit_amount":10000,"total_amount":10000}],"totals":{"subtotal":10000,"tax":0,"service_charge":0,"discount":0,"tip":0,"grand_total":10000},"occurred_at":"2026-07-18T10:30:00Z","metadata":{}}, separators=(",", ":"))
timestamp = str(int(time.time()))
signature = hmac.new(os.environ["RESTEC_REQUEST_SIGNING_SECRET"].encode(), f"{timestamp}.PUT.{path}.{body}".encode(), hashlib.sha256).hexdigest()
r = requests.put("https://sandbox-api.restec.io" + path, data=body, timeout=5, headers={"Authorization":"Bearer " + os.environ["RESTEC_API_KEY"],"Content-Type":"application/json","X-Restec-Timestamp":timestamp,"X-Restec-Signature":"v1="+signature,"X-Request-Id":"req_"+uuid.uuid4().hex,"Idempotency-Key":"bill-INV-1001-v1"})
if not r.ok: raise RuntimeError(f"Restec {r.status_code}: {r.text}")

payment_path = path + "/payment-sessions"
payment_body = json.dumps({"amount_minor":10000,"currency":"PKR","method":"card"}, separators=(",", ":"))
payment_ts = str(int(time.time()))
payment_sig = hmac.new(os.environ["RESTEC_REQUEST_SIGNING_SECRET"].encode(), f"{payment_ts}.POST.{payment_path}.{payment_body}".encode(), hashlib.sha256).hexdigest()
payment = requests.post("https://sandbox-api.restec.io" + payment_path, data=payment_body, timeout=5, headers={"Authorization":"Bearer " + os.environ["RESTEC_API_KEY"],"Content-Type":"application/json","X-Restec-Environment":"sandbox","X-Restec-Timestamp":payment_ts,"X-Restec-Signature":"v1="+payment_sig,"X-Request-Id":"req_"+uuid.uuid4().hex,"Idempotency-Key":"hosted-payment-INV-1001-1"})
if not payment.ok: raise RuntimeError(f"Restec payment session {payment.status_code}")
print(payment.json()["checkout_url"]) # Open for the customer; wait for a verified webhook.

app = Flask(__name__)
seen = set() # Replace with a database unique constraint and invoice update transaction.
@app.post("/integrations/restec/webhooks")
def webhook():
    raw = request.get_data(cache=False)
    timestamp = request.headers.get("X-Restec-Timestamp", "0")
    expected = "v1=" + hmac.new(os.environ["RESTEC_WEBHOOK_SIGNING_SECRET"].encode(), timestamp.encode()+b"."+raw, hashlib.sha256).hexdigest()
    if abs(time.time()-int(timestamp)) > 300 or not hmac.compare_digest(expected, request.headers.get("X-Restec-Signature", "")): return ("", 401)
    event_id = request.headers["X-Restec-Event-Id"]
    if event_id not in seen: seen.add(event_id)
    return ("", 202)
