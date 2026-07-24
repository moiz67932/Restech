using System.Net;
using System.Security.Cryptography;
using System.Text;

static string Hmac(string secret, string value) => Convert.ToHexString(new HMACSHA256(Encoding.UTF8.GetBytes(secret)).ComputeHash(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
var path = "/v1/locations/loc_example/bills/INV-1001";
var body = "{\"external_table_id\":\"12\",\"version\":1,\"currency\":\"PKR\",\"status\":\"open\",\"order_status\":\"accepted\",\"items\":[{\"external_item_id\":\"I1\",\"name\":\"Meal\",\"quantity\":1,\"unit_amount\":10000,\"total_amount\":10000}],\"totals\":{\"subtotal\":10000,\"tax\":0,\"service_charge\":0,\"discount\":0,\"tip\":0,\"grand_total\":10000},\"occurred_at\":\"2026-07-18T10:30:00Z\",\"metadata\":{}}";
var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
using var message = new HttpRequestMessage(HttpMethod.Put, "https://sandbox-api.restec.io" + path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
message.Headers.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("RESTEC_API_KEY"));
message.Headers.Add("X-Restec-Timestamp", ts); message.Headers.Add("X-Restec-Signature", "v1=" + Hmac(Environment.GetEnvironmentVariable("RESTEC_REQUEST_SIGNING_SECRET")!, $"{ts}.PUT.{path}.{body}"));
message.Headers.Add("X-Request-Id", "req_" + Guid.NewGuid().ToString("N")); message.Headers.Add("Idempotency-Key", "bill-INV-1001-v1");
var response = await client.SendAsync(message); if (!response.IsSuccessStatusCode) throw new Exception($"Restec {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");

var paymentPath = path + "/payment-sessions"; var paymentBody = "{\"amount_minor\":10000,\"currency\":\"PKR\",\"method\":\"card\"}"; var paymentTs = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
using var paymentMessage = new HttpRequestMessage(HttpMethod.Post, "https://sandbox-api.restec.io" + paymentPath) { Content = new StringContent(paymentBody, Encoding.UTF8, "application/json") };
paymentMessage.Headers.Add("Authorization", "Bearer " + Environment.GetEnvironmentVariable("RESTEC_API_KEY")); paymentMessage.Headers.Add("X-Restec-Environment", "sandbox"); paymentMessage.Headers.Add("X-Restec-Timestamp", paymentTs); paymentMessage.Headers.Add("X-Restec-Signature", "v1=" + Hmac(Environment.GetEnvironmentVariable("RESTEC_REQUEST_SIGNING_SECRET")!, $"{paymentTs}.POST.{paymentPath}.{paymentBody}")); paymentMessage.Headers.Add("X-Request-Id", "req_" + Guid.NewGuid().ToString("N")); paymentMessage.Headers.Add("Idempotency-Key", "hosted-payment-INV-1001-1");
var paymentResponse = await client.SendAsync(paymentMessage); if (!paymentResponse.IsSuccessStatusCode) throw new Exception($"Restec payment session {(int)paymentResponse.StatusCode}");
// Parse checkout_url, open it for the customer, and wait for the signed webhook.

// Minimal ASP.NET endpoint body:
// app.MapPost("/integrations/restec/webhooks", async (HttpRequest req, IDurableEventStore store) => {
//   using var memory=new MemoryStream(); await req.Body.CopyToAsync(memory); var raw=memory.ToArray();
//   var eventTs=req.Headers["X-Restec-Timestamp"].ToString(); var expected=Encoding.ASCII.GetBytes("v1="+Hmac(webhookSecret,eventTs+"."+Encoding.UTF8.GetString(raw)));
//   var supplied=Encoding.ASCII.GetBytes(req.Headers["X-Restec-Signature"].ToString());
//   if(Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds()-long.Parse(eventTs))>300 || expected.Length!=supplied.Length || !CryptographicOperations.FixedTimeEquals(expected,supplied)) return Results.Unauthorized();
//   await store.InsertUniqueAndApplyInvoiceAsync(req.Headers["X-Restec-Event-Id"],raw); return Results.Accepted();
// });
