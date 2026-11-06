param([Parameter(Mandatory=$true)][string]$Spec)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    if ($Spec -eq 'list') {
        $voices = @($synth.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
            [pscustomobject]@{ name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.TwoLetterISOLanguageName }
        })
        ConvertTo-Json -InputObject $voices -Compress
    } else {
        $inputData = Get-Content -Raw -Encoding UTF8 -LiteralPath $Spec | ConvertFrom-Json
        $synth.SelectVoice($inputData.speaker)
        foreach ($part in $inputData.parts) {
            $synth.SetOutputToWaveFile($part.file)
            $synth.Speak([string]$part.text)
            $synth.SetOutputToNull()
        }
    }
} finally {
    $synth.Dispose()
}
