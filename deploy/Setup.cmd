@echo off
rem Bam dup de cai bridge Telegram (BRIEF_HANDLER=claude, khong dung key) tren may nay.
rem Bridge se chay khi user nay dang nhap Windows. Muon chay ca khi chua ai dang nhap: dung Setup-24h.cmd.
rem Chay bang CHINH user se giu bot (phien dang nhap Claude nam trong profile user nay).
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
echo.
pause
