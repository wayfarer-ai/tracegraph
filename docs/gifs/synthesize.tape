# Live recording: synthesize real traces into a spec.
Output docs/gifs/synthesize.gif
Output docs/gifs/synthesize.txt
Set FontSize 15
Set Width 940
Set Height 520
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "alias tracegraph='node dist/cli.js' && clear"
Enter
Show

Type "# 16 real agent traces -> the graph the agent actually follows"
Enter
Sleep 500ms
Type "tracegraph synthesize examples/refund/traces -o refund.spec.yaml"
Enter
Sleep 8s
