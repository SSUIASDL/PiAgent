# 광삼이 Agent 배포 패키지

전역/배포 환경에서 로컬 절대경로에 의존하지 않고 API를 호출할 수 있도록 정리한 패키지입니다.

## 구성

```text
gwangsami-agent-package/
├─ API.txt                 # curl 호출 예시
├─ .env.example            # 환경변수 예시
├─ run.sh                  # macOS/Linux/Git Bash 실행 스크립트
├─ run.ps1                 # Windows PowerShell 실행 스크립트
└─ assets/
   ├─ gwangsami-logo.jpg
   └─ gwangsami-logo.txt
```

## 설정

배포/전역 사용 시 API Key와 Endpoint를 코드에 직접 넣지 말고 환경변수로 지정하세요.

### Windows PowerShell

```powershell
$env:API_KEY="your_api_key_here"
$env:ENDPOINT="your_endpoint_here"
.\run.ps1 "hello world!"
```

### macOS/Linux/Git Bash

```bash
export API_KEY="your_api_key_here"
export ENDPOINT="your_endpoint_here"
chmod +x ./run.sh
./run.sh "hello world!"
```

## API 직접 호출

```bash
curl --request POST \
  --url "https://agent.sec.samsung.net/api/v1/run/${ENDPOINT}?stream=true" \
  --header "Content-Type: application/json" \
  --header "x-api-key: ${API_KEY}" \
  --data '{
    "input_type": "chat",
    "output_type": "chat",
    "input_value": "hello world!"
  }'
```

## 배포 주의사항

- `D:/새 폴더/...` 같은 로컬 절대경로는 사용하지 마세요.
- 실제 배포 시 `API_KEY`, `ENDPOINT`는 환경변수/시크릿으로 관리하세요.
- `{endpoint}` 자리에는 실제 배포된 엔드포인트명을 넣어야 합니다.
