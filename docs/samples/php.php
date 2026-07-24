<?php
$path = '/v1/locations/loc_example/bills/INV-1001';
$body = json_encode(['external_table_id'=>'12','version'=>1,'currency'=>'PKR','status'=>'open','order_status'=>'accepted','items'=>[['external_item_id'=>'I1','name'=>'Meal','quantity'=>1,'unit_amount'=>10000,'total_amount'=>10000]],'totals'=>['subtotal'=>10000,'tax'=>0,'service_charge'=>0,'discount'=>0,'tip'=>0,'grand_total'=>10000],'occurred_at'=>'2026-07-18T10:30:00Z','metadata'=>(object)[]], JSON_UNESCAPED_SLASHES);
$ts = (string)time();
$signature = 'v1='.hash_hmac('sha256', "$ts.PUT.$path.$body", getenv('RESTEC_REQUEST_SIGNING_SECRET'));
$headers = ['Authorization: Bearer '.getenv('RESTEC_API_KEY'),'Content-Type: application/json',"X-Restec-Timestamp: $ts","X-Restec-Signature: $signature",'X-Request-Id: req_'.bin2hex(random_bytes(16)),'Idempotency-Key: bill-INV-1001-v1'];
$ch = curl_init('https://sandbox-api.restec.io'.$path);
curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST=>'PUT',CURLOPT_POSTFIELDS=>$body,CURLOPT_HTTPHEADER=>$headers,CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>5]);
$result = curl_exec($ch); $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($result === false || $status < 200 || $status >= 300) throw new RuntimeException("Restec HTTP $status: $result");

$paymentPath = $path.'/payment-sessions'; $paymentBody = json_encode(['amount_minor'=>10000,'currency'=>'PKR','method'=>'card']);
$paymentTs = (string)time(); $paymentSignature = 'v1='.hash_hmac('sha256', "$paymentTs.POST.$paymentPath.$paymentBody", getenv('RESTEC_REQUEST_SIGNING_SECRET'));
$paymentHeaders = ['Authorization: Bearer '.getenv('RESTEC_API_KEY'),'Content-Type: application/json','X-Restec-Environment: sandbox',"X-Restec-Timestamp: $paymentTs","X-Restec-Signature: $paymentSignature",'X-Request-Id: req_'.bin2hex(random_bytes(16)),'Idempotency-Key: hosted-payment-INV-1001-1'];
$paymentCurl = curl_init('https://sandbox-api.restec.io'.$paymentPath); curl_setopt_array($paymentCurl,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$paymentBody,CURLOPT_HTTPHEADER=>$paymentHeaders,CURLOPT_RETURNTRANSFER=>true]);
$paymentResult = curl_exec($paymentCurl); $paymentStatus = curl_getinfo($paymentCurl,CURLINFO_RESPONSE_CODE); if ($paymentStatus !== 201) throw new RuntimeException("Restec payment session HTTP $paymentStatus");
echo json_decode($paymentResult,true)['checkout_url']; // Open for the customer; payment remains asynchronous.

// Webhook route: read php://input exactly once before json_decode.
$raw = file_get_contents('php://input'); $eventTs = $_SERVER['HTTP_X_RESTEC_TIMESTAMP'] ?? '0';
$expected = 'v1='.hash_hmac('sha256', $eventTs.'.'.$raw, getenv('RESTEC_WEBHOOK_SIGNING_SECRET'));
if (abs(time()-(int)$eventTs)>300 || !hash_equals($expected, $_SERVER['HTTP_X_RESTEC_SIGNATURE'] ?? '')) { http_response_code(401); exit; }
$eventId = $_SERVER['HTTP_X_RESTEC_EVENT_ID']; // X-Restec-Event-Id
// INSERT eventId into a UNIQUE column and update the invoice in one database transaction; duplicate means success.
http_response_code(202);
?>
