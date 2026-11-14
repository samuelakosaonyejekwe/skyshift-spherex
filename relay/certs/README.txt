entrust-ov-tls-issuing-rsa-ca-2.pem
  Public intermediate certificate "Entrust OV TLS Issuing RSA CA 2" (issued by Sectigo Public Server Authentication
  Root R46), downloaded from the certificate's own Authority Information Access URL
  http://crt.sectigo.com/EntrustOVTLSIssuingRSACA2.crt on 2026-11-14.
  data.asc-csa.gc.ca (CSA open data, challenge resource 8) currently sends a wrong intermediate, so servers cannot
  verify it although browsers can (they fetch the missing intermediate themselves). The Node relay adds this one
  public certificate to the normal trusted roots for that host only; certificate verification stays fully on.
