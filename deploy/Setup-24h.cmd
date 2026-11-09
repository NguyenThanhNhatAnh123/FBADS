@echo off
rem Bam dup: cai bridge Telegram va cho chay luc bat may, ke ca khi chua ai dang nhap Windows (24/24).
rem Can quyen Administrator: Windows se hoi xac nhan. User dang dung phai la Admin va la user giu bot
rem (khong nhap tai khoan Admin khac, vi phien dang nhap Claude nam trong profile cua user nay).
cd /d "%~dp0.."
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" -AtStartup
echo.
pause
