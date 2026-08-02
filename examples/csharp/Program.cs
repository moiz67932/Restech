using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

static string Hmac(string secret, string input) =>
    Convert.ToHexString(new HMACSHA256(Encoding.UTF8.GetBytes(secret))
        .ComputeHash(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();

static string SignRequest(string secret, long timestamp, string method, string path, string body) =>
    "v1=" + Hmac(secret, $"{timestamp}.{method.ToUpperInvariant()}.{path}.{body}");

static string SignWebhook(string secret, long timestamp, string body) =>
    "v1=" + Hmac(secret, $"{timestamp}.{body}");

static bool FixedEquals(string left, string right)
{
    var a = Encoding.ASCII.GetBytes(left);
    var b = Encoding.ASCII.GetBytes(right);
    return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
}

static bool VerifyWebhook(string secret, long timestamp, string signature, string eventId,
    string environment, string rawBody, long now)
{
    if (Math.Abs(now - timestamp) > 300) return false;
    using var json = JsonDocument.Parse(rawBody);
    var root = json.RootElement;
    return root.GetProperty("event_id").GetString() == eventId
        && root.GetProperty("environment").GetString() == environment
        && root.GetProperty("event_version").GetString() == "1.0"
        && FixedEquals(signature, SignWebhook(secret, timestamp, rawBody));
}

static async Task<HttpResponseMessage> SendAsync(HttpClient http, string credential,
    string signingSecret, string method, string path, string? body = null,
    string? idempotencyKey = null, bool includeEnvironment = false)
{
    var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    body ??= "";
    using var request = new HttpRequestMessage(new HttpMethod(method), path);
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
    request.Headers.Add("X-Request-Id", "req_" + Guid.NewGuid().ToString("N"));
    request.Headers.Add("X-Restec-Timestamp", timestamp.ToString());
    request.Headers.Add("X-Restec-Signature", SignRequest(signingSecret, timestamp, method, path, body));
    if (idempotencyKey is not null) request.Headers.Add("Idempotency-Key", idempotencyKey);
    if (includeEnvironment) request.Headers.Add("X-Restec-Environment", "sandbox");
    request.Content = new StringContent(body, Encoding.UTF8, "application/json");
    var response = await http.SendAsync(request);
    if ((int)response.StatusCode == 429 && response.Headers.RetryAfter?.Delta is { } delay)
        await Task.Delay(delay);
    return response;
}

var webhookSecret = "example-webhook-secret-not-for-production";
var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
var webhookBody = """
{"event_id":"evt_example1001","event_type":"payment.completed","event_version":"1.0","occurred_at":"2026-08-02T10:06:00Z","environment":"sandbox","partner_id":"ptr_example","location_id":"loc_example","external_bill_id":"BILL-1001","payment_reference":"pay_example1001","amount_minor":10000,"currency":"PKR","payment_method":"cash","payment_status":"completed","bill":{"grand_total":10000,"amount_paid":10000,"amount_refunded":0,"amount_due":0,"payment_status":"paid","version":2},"metadata":{}}
""";
var webhookSignature = SignWebhook(webhookSecret, timestamp, webhookBody);
if (!VerifyWebhook(webhookSecret, timestamp, webhookSignature, "evt_example1001", "sandbox",
        webhookBody, timestamp)) throw new Exception("Webhook verification failed");
var seen = new HashSet<string>();
if (!seen.Add("evt_example1001")) throw new Exception("First event was not stored");
if (seen.Add("evt_example1001")) throw new Exception("Duplicate event was not deduplicated");

if (Environment.GetEnvironmentVariable("RUN_RESTEC_EXAMPLES") == "1")
{
    var baseUrl = Environment.GetEnvironmentVariable("RESTEC_BASE_URL")!;
    var credential = Environment.GetEnvironmentVariable("RESTEC_API_CREDENTIAL")!;
    var signingSecret = Environment.GetEnvironmentVariable("RESTEC_REQUEST_SIGNING_SECRET")!;
    var location = Environment.GetEnvironmentVariable("RESTEC_LOCATION_ID")!;
    using var http = new HttpClient { BaseAddress = new Uri(baseUrl) };
    var billPath = $"/v1/locations/{Uri.EscapeDataString(location)}/bills/BILL-1001";
    var bill = """
    {"external_table_id":"TABLE-12","external_order_id":"ORDER-1001","version":1,"currency":"PKR","status":"open","order_status":"accepted","items":[{"external_item_id":"ITEM-1","name":"Lunch","quantity":1,"unit_amount":10000,"total_amount":10000}],"totals":{"subtotal":10000,"tax":0,"service_charge":0,"discount":0,"tip":0,"grand_total":10000},"occurred_at":"2026-08-02T10:00:00Z","metadata":{}}
    """;
    var response = await SendAsync(http, credential, signingSecret, "PUT", billPath, bill, "bill-BILL-1001-v1");
    response.EnsureSuccessStatusCode();
    Console.WriteLine($"Bill upsert: {(int)response.StatusCode}");
    var cashBillPath = $"/v1/locations/{Uri.EscapeDataString(location)}/bills/BILL-CASH-1001";
    response = await SendAsync(http, credential, signingSecret, "PUT", cashBillPath,
        bill.Replace("ORDER-1001", "ORDER-CASH-1001"), "bill-BILL-CASH-1001-v1");
    response.EnsureSuccessStatusCode();
    var cash = """
    {"external_payment_id":"CASH-1001","method":"cash","amount":10000,"currency":"PKR","status":"completed","occurred_at":"2026-08-02T10:05:00Z","metadata":{}}
    """;
    response = await SendAsync(http, credential, signingSecret, "POST", cashBillPath + "/external-payments", cash, "payment-CASH-1001");
    response.EnsureSuccessStatusCode();
    Console.WriteLine($"Cash payment: {(int)response.StatusCode}");
    var terminalBillPath = $"/v1/locations/{Uri.EscapeDataString(location)}/bills/BILL-TERMINAL-1002";
    response = await SendAsync(http, credential, signingSecret, "PUT", terminalBillPath,
        bill.Replace("ORDER-1001", "ORDER-TERMINAL-1002"), "bill-BILL-TERMINAL-1002-v1");
    response.EnsureSuccessStatusCode();
    var terminal = """
    {"external_payment_id":"TERMINAL-1002","method":"card_terminal","amount":10000,"currency":"PKR","status":"completed","occurred_at":"2026-08-02T10:06:00Z","processor_reference":"APPROVAL-1002","metadata":{}}
    """;
    response = await SendAsync(http, credential, signingSecret, "POST", terminalBillPath + "/external-payments", terminal, "payment-TERMINAL-1002");
    response.EnsureSuccessStatusCode();
    Console.WriteLine($"Terminal payment: {(int)response.StatusCode}");
}

Console.WriteLine("Restec C# examples self-test passed; return HTTP 204 after durable webhook commit.");
