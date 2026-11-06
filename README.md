# 연세솔안과 진료안내 영상 스튜디오

원고를 등록하고 아바타가 말하는 안내 영상에 자막·단계 제목·로고를 넣는 원내 웹 프로그램입니다. 음성과 영상은 원내 PC에서 합성합니다. 초기 모델 설치에는 인터넷이 필요하며, 설치 후에는 외부 계정이나 API 키 없이 실행합니다.

## 설치와 실행

1. 원내 PC에 [Node.js 24 LTS](https://nodejs.org/en/download)와 [FFmpeg](https://ffmpeg.org/download.html)를 설치합니다. FFmpeg는 `libass`와 `libx264`를 지원해야 합니다.
2. 저장소를 내려받아 압축을 풀고 해당 폴더에서 PowerShell을 엽니다. 최초 설정에서만 `.env`를 복사합니다.

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   npm.cmd start
   ```

3. [원내 스튜디오](http://127.0.0.1:8787/)를 엽니다. 원고 편집·백업과 병원 설정은 바로 사용할 수 있습니다. FFmpeg가 PATH에 없다면 `FFMPEG_PATH`에 실행 파일의 절대 경로를 입력합니다. Windows 한글 자막에는 기본으로 맑은 고딕을 사용합니다.
4. Windows에 설치된 음성이 있으면 **영상 만들기**에서 원고 언어에 맞는 음성이 표시됩니다. 한국어 음성이 보이지 않거나 Qwen 음성을 사용하려면 아래의 한국어 모델을 설치합니다.

### 한국어 기본 음성

[Python 3.12](https://www.python.org/downloads/)를 설치하고 앱 폴더에서 다음 명령을 실행합니다. NVIDIA GPU를 사용하려면 [PyTorch 설치 안내](https://pytorch.org/get-started/locally/)에서 PC와 호환되는 CUDA 빌드를 같은 가상환경에 설치합니다.

```powershell
py -3.12 -m venv .venv-tts
.\.venv-tts\Scripts\python.exe -m pip install qwen-tts huggingface_hub
.\.venv-tts\Scripts\hf.exe download Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice --local-dir models/qwen-tts
```

`.env`의 `TTS_PYTHON`에 `.venv-tts\Scripts\python.exe`, `QWEN_TTS_MODEL`에 `models\qwen-tts` 폴더의 **절대 경로**를 입력한 뒤 서버를 다시 실행합니다. 한국어 원고에서 **Sohee · Qwen3-TTS**를 선택할 수 있습니다. 합성은 다운로드한 모델만 사용합니다.

### 실사 얼굴과 등록 음성

- **얼굴**. [MuseTalk 1.5](https://github.com/TMElyralab/MuseTalk)의 설치·가중치 다운로드를 별도의 Python 환경에서 완료합니다. NVIDIA CUDA가 활성화된 환경의 Python 실행 파일과 MuseTalk 설치 폴더를 `MUSETALK_PYTHON`, `MUSETALK_DIR`에 각각 지정합니다. 서버를 재시작하고 **영상 만들기 → 사진 아바타 관리**에서 사용에 동의한 성인의 정면 사진을 등록합니다. 사진은 PNG 또는 JPEG, 최대 1MB입니다. 입 모양은 사진과 생성한 음성으로 로컬에서 합성합니다.
- **음성**. 위 가상환경의 `hf.exe`로 `Qwen/Qwen3-TTS-12Hz-0.6B-Base`를 별도 폴더에 다운로드하고 `QWEN_CLONE_MODEL`에 지정합니다. `VOICE_REFERENCES` 폴더에 동의받은 `이름.wav`와 실제로 말한 내용을 담은 UTF-8 `이름.txt`를 짝으로 넣습니다. 해당 음성이 지원 언어의 목록에 나타납니다. 원본 사진과 녹음은 원내에 보관합니다.
- 일러스트 아바타는 음성에 맞춰 입을 움직이며 MuseTalk 설치 없이 사용할 수 있습니다. MuseTalk를 설치할 때 원본 프로젝트의 테스트 이미지·영상 대신 동의받은 자료를 사용하고, 함께 사용하는 모델의 라이선스를 확인합니다.

### 원고 초안과 번역

[Ollama](https://ollama.com/download)를 원내 PC에 설치하고 `ollama pull qwen2.5:7b`를 실행합니다. Ollama의 클라우드 기능을 [로컬 전용 모드](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)로 끄고 재시작한 뒤 앱의 `.env`에 `OLLAMA_MODEL=qwen2.5:7b`를 설정합니다. 앱은 같은 PC의 Ollama에 설치된 모델만 사용합니다.

## 제작 순서

1. **스크립트 등록**에서 원고를 최대 4단계로 나눕니다. SRT에서 대사를 가져오거나 JSON 백업으로 원고를 복원할 수 있습니다.
2. **영상 만들기**에서 원고, 아바타, 음성, 가로·세로 화면비를 선택합니다. 문장별 음성 길이로 자막 시점을 계산합니다.
3. **생성 이력**에서 결과를 재생·다운로드합니다. **다시 꾸미기**는 저장된 영상에 자막과 로고를 다시 합성합니다.
4. **안내문구 설정**에서 환자 페이지 문구와 AI 고지를 관리합니다. 공유 링크는 생성 이력에서 발급하거나 해제할 수 있습니다.

## 원내 PC 여러 대에서 사용

기본 모드는 실행한 PC 한 대에서 작동합니다. 원내망에서 사용하려면 고정 사설 IPv4 주소가 있는 PC에 서버를 실행하고, 접속 IP를 포함하는 신뢰 가능한 TLS 인증서와 키를 준비합니다.

- `.env`에 `CLINIC_ORIGIN`, `PORT`, 16자 이상의 `CLINIC_PASSWORD`, `TLS_CERT_FILE`, `TLS_KEY_FILE`을 지정합니다. 설정 예시는 `.env.example`을 참고합니다.
- 원내 PC와 내부 Wi-Fi에서 접속을 확인하고, 방화벽은 해당 원내 대역으로 제한합니다. 환자용 링크는 원내망에서 재생됩니다.
- SQLite와 영상은 `data/`에 저장합니다. 백업할 때 서버를 종료하고 이 폴더 전체를 복사합니다. 한 데이터 폴더는 한 서버 프로세스에서 사용합니다.
- 기존 버전에서 업데이트할 때는 `data/`를 유지합니다. 이전에 완성한 영상과 원고는 계속 열 수 있습니다. 이전 방식에서 미완료인 영상 작업은 원고를 열어 새로 생성합니다.
- GitHub Pages의 게시 경로인 `main` 브랜치의 `/docs`에는 실행 안내만 포함됩니다.

## 엔진 문서

- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- [MuseTalk](https://github.com/TMElyralab/MuseTalk)
- [Ollama Generate API](https://docs.ollama.com/api/generate)
