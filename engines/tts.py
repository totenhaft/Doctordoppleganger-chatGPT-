import json
import sys
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    model_path = Path(spec["model"]).resolve(strict=True)
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    model = Qwen3TTSModel.from_pretrained(
        str(model_path),
        device_map=device,
        dtype=torch.bfloat16 if device.startswith("cuda") and torch.cuda.is_bf16_supported() else torch.float32,
        attn_implementation="sdpa",
        local_files_only=True,
    )
    reference = spec.get("reference")
    if reference:
        ref_audio, ref_rate = sf.read(reference["audio"], dtype="float32")
        if ref_audio.ndim > 1:
            ref_audio = ref_audio.mean(axis=1)
        prompt = model.create_voice_clone_prompt(
            ref_audio=(ref_audio, ref_rate),
            ref_text=Path(reference["text"]).read_text(encoding="utf-8-sig").strip(),
        )
    for item in spec["parts"]:
        args = {"text": item["text"], "language": spec["language"]}
        if reference:
            waves, rate = model.generate_voice_clone(**args, voice_clone_prompt=prompt)
        else:
            waves, rate = model.generate_custom_voice(**args, speaker=spec["speaker"])
        sf.write(item["file"], waves[0], rate, subtype="PCM_16")


if __name__ == "__main__":
    main()
