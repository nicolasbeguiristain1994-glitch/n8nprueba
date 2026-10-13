// Shared transport policy for the panel and its maintenance/import scripts.
// Public Supabase CA bundle (2021 root through 2031; 2025 root through 2035).
// SHA256: 807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa
const SUPABASE_CA = "-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIDxzCCAq+gAwIBAgIUeX+gpfmsRW9asFkRvjyXjHxbfgcwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTI1MDkwMzA4MDEyNVoXDTM1MDkwMTA4MDEyNVow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5Ve7\ni9UAmc7luUilELPtqzEk8nGHxg7nY0aCStr625M7+K4OPO6RUllTsHh47k1jWyzm\nLXLlyYwCsYCjQp+3vn06H+F/HRUxBt6CK2B7bNng230exTunk0xFvfkX6YgHR7B3\n1B7L25Rq3PhuRFPV4hnGYRam2XBZC4UNPqoAgrhV0HOYzXXAVoTr2yaBTMnB331Z\nRwOmINh7eqTCk/JRZbb6vfZOhZRAVAe9AoRLoG8aKwmeoLGwlu0UuFx6z3E+6bmA\nfSNa8Lx02GEoCdPLw9IRKUFq/SgBpQUKm44H1fDwTjH2CMM0N4p0mL/6wXnNeHvt\nC40MmKZ0RcVmHE5wBwIDAQABo2MwYTAdBgNVHQ4EFgQUjvEE541toZcwtXQlZlcB\nYOBRTnowHwYDVR0jBBgwFoAUjvEE541toZcwtXQlZlcBYOBRTnowDwYDVR0TAQH/\nBAUwAwEB/zAOBgNVHQ8BAf8EBAMCAYYwDQYJKoZIhvcNAQELBQADggEBACD5IcGP\nXKvS9qg0CgEQPFqYavt5c7P+0xxFgiZe+xoG8fUw58yNeK2APtgGPRpxEOGfAlNx\nz9HDt4gcyHEE00B3qAVDm49pqNxioFWzNqU2LGfM/HL1QmN6urR7hCOkVCJddvOc\nFhFX4nZDuRfaBboDvS5HlK3Pzxddp9hvrJi2bemr8HLqYc3HzmVckgPGSLML6t+h\n4LRCXSlQsDgQ1LZ4KHsl4cq7K51N6FOXQBLB5q4lMKhs0VUhCT8Pdsj12+84laCV\nc22q6p2mdT9SaernCSRnWazXWisgpjv3H7Ex4S1DCYjJIwn3PUToGFv1r8YRN2/S\nO19yVSxxCIf64Sg=\n-----END CERTIFICATE-----";

function secureDatabaseTransport(connectionString, host, env = process.env) {
  let normalizedUrl;
  if (connectionString && connectionString.trim()) {
    const url = new URL(connectionString.trim());
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database URL protocol');
    if (['host', 'hostaddr', 'port'].some(key => url.searchParams.has(key))) throw new Error('Database URL endpoint overrides are not allowed');
    host = url.hostname;
    // pg lets these URL options override the explicit ssl object. Never let a
    // copied sslmode=require/no-verify URL turn certificate verification off.
    for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
    normalizedUrl = url.toString();
  }
  host = String(host || '').trim().toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  const sslSetting = String(env.DB_POSTGRESDB_SSL ?? env.DB_SSL ?? '').trim();
  const verifySetting = String(env.DB_SSL_REJECT_UNAUTHORIZED ?? '').trim();
  if (!local && (sslSetting === 'false' || verifySetting === 'false')) {
    throw new Error('Remote database connections require TLS certificate verification');
  }
  const ca = env.DB_SSL_CA?.trim() || (/\.(?:supabase\.co|pooler\.supabase\.com)$/.test(host) ? SUPABASE_CA : undefined);
  const ssl = local && sslSetting !== 'true' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  return { ...(normalizedUrl ? { connectionString: normalizedUrl } : {}), ssl };
}

module.exports = { secureDatabaseTransport };
