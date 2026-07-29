# Gate demo GIF. NOTE: vhs's pty cannot host the MCP stdio handshake (the
# child gate boots but the client handshake stalls under the recorder —
# works everywhere else), so this tape renders the GENUINE transcript
# captured from a real run (examples/refund/demo-transcript.txt). Users
# reproduce it live with the README commands.
Output docs/gifs/gate-demo.gif
Output docs/gifs/gate-demo.txt
Set FontSize 15
Set Width 940
Set Height 420
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "clear && sh -c 'sleep 6; cat examples/refund/demo-transcript.txt; sleep 30' "
Enter
Sleep 1s
Show
Sleep 12s
