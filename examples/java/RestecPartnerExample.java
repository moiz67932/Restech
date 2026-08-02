import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

public final class RestecPartnerExample {
  static String hex(byte[] bytes) {
    var value = new StringBuilder();
    for (byte b : bytes) value.append(String.format("%02x", b));
    return value.toString();
  }
  static String hmac(String secret, String input) throws Exception {
    var mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    return hex(mac.doFinal(input.getBytes(StandardCharsets.UTF_8)));
  }
  static String signRequest(String secret, long timestamp, String method, String path, String body) throws Exception {
    return "v1=" + hmac(secret, timestamp + "." + method.toUpperCase() + "." + path + "." + body);
  }
  static String signWebhook(String secret, long timestamp, String body) throws Exception {
    return "v1=" + hmac(secret, timestamp + "." + body);
  }
  static boolean verifyWebhook(String secret, long timestamp, String signature, String eventId,
      String environment, String body, long now) throws Exception {
    if (Math.abs(now - timestamp) > 300) return false;
    if (!body.contains("\"event_id\":\"" + eventId + "\"")
        || !body.contains("\"environment\":\"" + environment + "\"")
        || !body.contains("\"event_version\":\"1.0\"")) return false;
    return MessageDigest.isEqual(signature.getBytes(StandardCharsets.US_ASCII),
        signWebhook(secret, timestamp, body).getBytes(StandardCharsets.US_ASCII));
  }
  static HttpResponse<String> send(HttpClient http, String baseUrl, String credential,
      String signingSecret, String method, String path, String body, String idempotencyKey,
      boolean includeEnvironment) throws Exception {
    long timestamp = Instant.now().getEpochSecond();
    var builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
        .header("Authorization", "Bearer " + credential)
        .header("Content-Type", "application/json")
        .header("X-Request-Id", "req_" + UUID.randomUUID().toString().replace("-", ""))
        .header("X-Restec-Timestamp", Long.toString(timestamp))
        .header("X-Restec-Signature", signRequest(signingSecret, timestamp, method, path, body));
    if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
    if (includeEnvironment) builder.header("X-Restec-Environment", "sandbox");
    if (method.equals("GET")) builder.GET(); else builder.method(method, HttpRequest.BodyPublishers.ofString(body));
    return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
  }
  public static void main(String[] args) throws Exception {
    String secret = "example-webhook-secret-not-for-production";
    long timestamp = Instant.now().getEpochSecond();
    String body = "{\"event_id\":\"evt_example1001\",\"event_type\":\"payment.completed\",\"event_version\":\"1.0\",\"occurred_at\":\"2026-08-02T10:06:00Z\",\"environment\":\"sandbox\",\"partner_id\":\"ptr_example\",\"location_id\":\"loc_example\",\"external_bill_id\":\"BILL-1001\",\"payment_reference\":\"pay_example1001\",\"amount_minor\":10000,\"currency\":\"PKR\",\"payment_method\":\"cash\",\"payment_status\":\"completed\",\"bill\":{\"grand_total\":10000,\"amount_paid\":10000,\"amount_refunded\":0,\"amount_due\":0,\"payment_status\":\"paid\",\"version\":2},\"metadata\":{}}";
    if (!verifyWebhook(secret, timestamp, signWebhook(secret, timestamp, body),
        "evt_example1001", "sandbox", body, timestamp)) throw new IllegalStateException("signature");
    var seen = new HashSet<String>();
    if (!seen.add("evt_example1001") || seen.add("evt_example1001"))
      throw new IllegalStateException("deduplication");
    System.out.println("Restec Java examples self-test passed; return HTTP 204 after durable webhook commit.");
  }
}
