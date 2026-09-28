# Demo recording for the README. Test data only: /tmp/rundev-demo/acme
# (three fake repos, services running as real `sleep` processes so the sidebar
# shows real pids and real liveness).

Output "/tmp/rundev-demo/rec.gif"

Set Shell zsh
Set FontSize 11
Set Width 1600
Set Height 820
Set Padding 0
Set Theme "TokyoNight"

Type "cd /tmp/rundev-demo/acme"
Enter
Sleep 600ms
Type "opencode --standalone"
Enter
Sleep 14s

# 1) /rundev status -> picker -> report
Type "/rundev"
Sleep 1300ms
Enter
Sleep 900ms
Type "status"
Sleep 400ms
Enter
Sleep 2s
Screenshot "docs/shots/picker.png"
Enter
Sleep 5s
Screenshot "docs/shots/report.png"
Escape
Sleep 2s

Type "which services are up right now? answer in English"
Enter
Sleep 55s

# 3) sidebar on, then the shot with both
Sleep 2500ms
Screenshot "docs/shots/sidebar.png"

# 4) /rundev up -> the checkbox picker
Type "/rundev"
Sleep 1300ms
Enter
Sleep 900ms
Type "up"
Sleep 400ms
Enter
Sleep 2500ms
Screenshot "docs/shots/hero.png"
Escape
Sleep 800ms
