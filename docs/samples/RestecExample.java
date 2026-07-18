import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.security.MessageDigest;
import com.sun.net.httpserver.HttpServer;

public class RestecExample {
  static String hmac(String secret, byte[] input) throws Exception {
    Mac mac=Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
    return HexFormat.of().formatHex(mac.doFinal(input));
  }
  public static void main(String[] args) throws Exception {
    String path="/v1/locations/loc_example/bills/INV-1001";
    String body="{\"external_table_id\":\"12\",\"version\":1,\"currency\":\"PKR\",\"status\":\"open\",\"order_status\":\"accepted\",\"items\":[{\"external_item_id\":\"I1\",\"name\":\"Meal\",\"quantity\":1,\"unit_amount\":10000,\"total_amount\":10000}],\"totals\":{\"subtotal\":10000,\"tax\":0,\"service_charge\":0,\"discount\":0,\"tip\":0,\"grand_total\":10000},\"occurred_at\":\"2026-07-18T10:30:00Z\",\"metadata\":{}}";
    String ts=Long.toString(Instant.now().getEpochSecond());
    String signature="v1="+hmac(System.getenv("RESTEC_REQUEST_SIGNING_SECRET"),(ts+".PUT."+path+"."+body).getBytes(StandardCharsets.UTF_8));
    HttpRequest request=HttpRequest.newBuilder(URI.create("https://sandbox-api.restec.io"+path)).PUT(HttpRequest.BodyPublishers.ofString(body)).header("Authorization","Bearer "+System.getenv("RESTEC_API_KEY")).header("Content-Type","application/json").header("X-Restec-Timestamp",ts).header("X-Restec-Signature",signature).header("X-Request-Id","req_"+UUID.randomUUID().toString().replace("-","")).header("Idempotency-Key","bill-INV-1001-v1").build();
    HttpResponse<String> response=HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(5)).build().send(request,HttpResponse.BodyHandlers.ofString());
    if(response.statusCode()/100!=2) throw new RuntimeException("Restec "+response.statusCode()+": "+response.body());

    Set<String> seen=ConcurrentHashMap.newKeySet(); // Replace with a database unique constraint.
    HttpServer server=HttpServer.create(new java.net.InetSocketAddress(8443),0);
    server.createContext("/integrations/restec/webhooks", exchange -> { try {
      byte[] raw=exchange.getRequestBody().readAllBytes(); String eventTs=exchange.getRequestHeaders().getFirst("X-Restec-Timestamp");
      byte[] expected=HexFormat.of().parseHex(hmac(System.getenv("RESTEC_WEBHOOK_SIGNING_SECRET"),(eventTs+"."+new String(raw,StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8)));
      String suppliedValue=exchange.getRequestHeaders().getFirst("X-Restec-Signature"); byte[] supplied=HexFormat.of().parseHex(suppliedValue.replaceFirst("^v1=",""));
      if(Math.abs(Instant.now().getEpochSecond()-Long.parseLong(eventTs))>300 || !MessageDigest.isEqual(expected,supplied)){exchange.sendResponseHeaders(401,-1);return;}
      seen.add(exchange.getRequestHeaders().getFirst("X-Restec-Event-Id")); // Transactionally update invoice only on first insert.
      exchange.sendResponseHeaders(202,-1);
    } catch(Exception e){exchange.sendResponseHeaders(400,-1);} finally {exchange.close();}}); server.start();
  }
}
