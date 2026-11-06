# 연세솔안과 진료안내 영상 스튜디오

안내 원고를 저장하고, HeyGen 아바타 영상에 자막·단계 배지·병원 로고를 입힌 뒤 원내망에서 보여 주는 도구입니다.

## 설치와 실행

1. 원내 Windows PC에 [Node.js 24 LTS](https://nodejs.org/en/download)와 [FFmpeg](https://ffmpeg.org/download.html)를 설치합니다. FFmpeg는 `libass`와 `libx264`를 지원해야 합니다.
2. 저장소를 내려받아 압축을 풀고 PowerShell에서 해당 폴더를 엽니다.
3. 아래 명령을 실행합니다. `.env`는 최초 설정 때 한 번만 복사합니다.

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   npm.cmd start
   ```

4. `.env`에 `HEYGEN_API_KEY`를 입력하고 저장한 뒤 서버를 시작합니다. FFmpeg가 PATH에 없다면 `FFMPEG_PATH`에 실행 파일의 절대 경로를 입력합니다. 한글 자막용 기본 글꼴은 맑은 고딕입니다. 다른 OS에서는 설치된 한글 글꼴을 `CAPTION_FONT`로 지정합니다.
5. 브라우저에서 [원내 스튜디오](http://127.0.0.1:8787/)를 열고 **병원 설정 → HeyGen 연결 확인**을 누릅니다. 원고 편집과 병원 설정은 API 키를 설정하기 전에도 사용할 수 있습니다.

## 제작 순서

1. **스크립트 등록**에서 원고를 1~4단계로 나눕니다. SRT는 대사만 가져오며, JSON 백업 파일은 원고·제목·언어를 복원합니다. AI 초안과 번역은 `OPENAI_API_KEY`를 설정하면 사용할 수 있습니다.
2. **영상 만들기**에서 원고와 아바타를 선택하고 가로 또는 세로 화면을 설정합니다. 영상 요청 시 제목과 대사가 HeyGen으로 전송되며 API 크레딧이 사용됩니다. 환자 이름, 생년월일, 차트 내용 등 개인 식별 정보는 원고에 넣지 않습니다.
3. **생성 이력**에서 결과를 재생하고 MP4를 내려받습니다. **다시 꾸미기**는 원내에 내려받은 원본 영상에 자막과 로고를 다시 합성합니다. 제작 중 서버를 닫으면 알려진 작업 ID에서 재개합니다. 접수 확인 필요 상태는 새 요청 전에 HeyGen 대시보드에서 확인합니다.
4. 환자 안내문과 AI 고지는 **안내문구 설정**에서 관리합니다. 생성 이력에서 영상별로 공유 링크를 발급하거나 해제할 수 있습니다. 링크를 가진 사람이 영상을 볼 수 있으므로 일반 안내 영상만 공유합니다.

## 원내 PC 여러 대에서 사용

기본 설정은 실행한 PC 한 대에서 작동합니다. 원내망에서 공유하려면 고정 사설 IPv4 주소가 있는 PC에 서버를 실행하고, 병원에서 관리하는 TLS 인증서와 키를 준비합니다. 인증서는 접속 IP를 포함하고 사용자 기기에서 신뢰할 수 있어야 합니다.

- `.env`에서 `CLINIC_ORIGIN`, `PORT`, 16자 이상의 `CLINIC_PASSWORD`, `TLS_CERT_FILE`, `TLS_KEY_FILE`을 설정합니다. 예시는 `.env.example`에 있습니다.
- 원내 PC와 환자에게 제공할 내부 Wi-Fi에서 접근 가능한지 확인합니다. Windows 방화벽에서 필요한 원내 대역에만 허용합니다.
- API 키, SQLite DB, 영상은 원내 서버에 둡니다. 백업할 때 서버를 종료한 뒤 `data/` 전체를 복사합니다. 한 데이터 폴더는 한 서버 프로세스에서 사용합니다.
- GitHub Pages의 게시 경로는 `main` 브랜치의 `/docs`입니다. 이 경로에는 정적 실행 안내만 있습니다.

## 참고 문서

- [HeyGen Create Video](https://developers.heygen.com/reference/create-video)
- [HeyGen Get Video](https://developers.heygen.com/reference/get-video)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [GitHub Pages 게시 경로 설정](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
