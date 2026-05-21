param(
  [string]$InputValue = "hello world!"
)

# 사용법:
#   $env:API_KEY="..."
#   $env:ENDPOINT="..."
#   .\run.ps1 "hello world!"

$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "https://agent.sec.samsung.net" }
$ApiKey = $env:API_KEY
$Endpoint = $env:ENDPOINT

if ([string]::IsNullOrWhiteSpace($ApiKey) -or [string]::IsNullOrWhiteSpace($Endpoint)) {
  Write-Error "API_KEY and ENDPOINT must be set. See .env.example"
  exit 1
}

$Body = @{
  input_type = "chat"
  output_type = "chat"
  input_value = $InputValue
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/api/v1/run/$Endpoint?stream=true" `
  -ContentType "application/json" `
  -Headers @{ "x-api-key" = $ApiKey } `
  -Body $Body
