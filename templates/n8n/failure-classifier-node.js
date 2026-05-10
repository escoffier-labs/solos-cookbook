const item = $input.first()?.json ?? {};
const message = String(item.error?.message ?? item.message ?? "");

let bucket = "unknown";
let severity = "info";

if (/timeout|ETIMEDOUT|deadline/i.test(message)) {
  bucket = "timeout";
  severity = "warning";
} else if (/auth|unauthorized|forbidden|credential/i.test(message)) {
  bucket = "auth";
  severity = "error";
} else if (/rate.?limit|too many requests/i.test(message)) {
  bucket = "rate-limit";
  severity = "warning";
} else if (/schema|validation|invalid/i.test(message)) {
  bucket = "schema";
  severity = "error";
}

return [
  {
    json: {
      ...item,
      failure: {
        bucket,
        severity,
        message
      }
    }
  }
];
