#!/bin/bash
# MCP Debug Wrapper - Captures stderr for debugging
# This script wraps the MCP command and logs all output

LOG_FILE="/tmp/mcp-debug.log"

echo "[$(date)] ==================== MCP Wrapper Started ====================" >> $LOG_FILE
echo "[$(date)] CWD: $(pwd)" >> $LOG_FILE
echo "[$(date)] PATH: $PATH" >> $LOG_FILE
echo "[$(date)] HOME: $HOME" >> $LOG_FILE
echo "[$(date)] USER: $USER" >> $LOG_FILE
echo "" >> $LOG_FILE

# Run npx with -y flag, redirect stderr to log file while keeping stdout clean for MCP protocol
/opt/homebrew/bin/npx -y @anthropic-ai/claude-playwright-mcp@latest 2>> $LOG_FILE

EXIT_CODE=$?
echo "[$(date)] Process exited with code $EXIT_CODE" >> $LOG_FILE
echo "[$(date)] ==================== MCP Wrapper Ended ====================" >> $LOG_FILE
