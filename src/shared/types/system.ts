export type SystemInitInfo = {
  timestamp: string;
  type?: string;
  subtype?: string;
  cwd?: string;
  session_id?: string;
  tools?: string[];
  mcp_servers?: string[];
  model?: string;
  permissionMode?: string;
  slash_commands?: string[];
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: string[];
  uuid?: string;
};
