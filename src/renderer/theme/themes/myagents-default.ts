import { APP_BUILD_PROFILE, APP_DISPLAY_NAME } from '../../../shared/appProfile';
import './myagents-default.css';
import stylesheetText from './myagents-default.css?inline';
import { createPrismStyle } from '../prism-style';
import type { ThemeDefinition, ThemeSchemeDefinition } from '../types';

const fontCode = "ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'Fira Code', 'PingFang SC', 'Microsoft YaHei', 'Microsoft YaHei UI', 'Hiragino Sans GB', monospace";
const xtermFont = "'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'PingFang SC', 'Microsoft YaHei', monospace";
const mermaidFont = "'Avenir Next', 'Gill Sans', 'PingFang SC', 'Microsoft YaHei', 'Microsoft YaHei UI', sans-serif";
const widgetFont = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

const widgetStructure = {
  '--widget-font-body': widgetFont,
  '--widget-radius-track': '3px',
  '--widget-radius-control': '8px',
  '--widget-radius-card': '12px',
  '--widget-radius-full': '9999px',
  '--widget-control-shadow': '0 1px 3px rgba(0, 0, 0, 0.15)',
} as const;

const lightWidgetVariables = {
  '--widget-text': '#1c1612',
  '--widget-text-secondary': '#6f6156',
  '--widget-text-muted': '#a69a90',
  '--widget-bg': 'transparent',
  '--widget-bg-elevated': '#fffcf7',
  '--widget-bg-inset': '#e8dccf',
  '--widget-border': 'rgb(28 22 18 / 0.10)',
  '--widget-border-strong': 'rgb(28 22 18 / 0.18)',
  '--widget-accent': '#c26d3a',
  '--widget-accent-hover': '#e18a58',
  '--widget-accent-subtle': 'rgba(194, 109, 58, 0.08)',
  '--widget-success': '#2d8a5e',
  '--widget-success-bg': '#e2f0e8',
  '--widget-error': '#dc2626',
  '--widget-error-bg': '#fee2e2',
  '--widget-warning': '#d97706',
  '--widget-warning-bg': '#fef3c7',
  '--widget-info': '#4a7ab5',
  '--widget-info-bg': '#e4ecf4',
  '--widget-primary-text': '#ffffff',
  ...widgetStructure,
} as const;

const darkWidgetVariables = {
  '--widget-text': '#e4dcd4',
  '--widget-text-secondary': '#968a7e',
  '--widget-text-muted': '#685c52',
  '--widget-bg': 'transparent',
  '--widget-bg-elevated': '#242018',
  '--widget-bg-inset': '#12100e',
  '--widget-border': 'rgb(228 220 212 / 0.10)',
  '--widget-border-strong': 'rgb(228 220 212 / 0.18)',
  '--widget-accent': '#d4803f',
  '--widget-accent-hover': '#e89860',
  '--widget-accent-subtle': 'rgba(212, 128, 63, 0.12)',
  '--widget-success': '#4aad7a',
  '--widget-success-bg': 'rgba(74, 173, 122, 0.15)',
  '--widget-error': '#ef4444',
  '--widget-error-bg': 'rgba(239, 68, 68, 0.15)',
  '--widget-warning': '#f59e0b',
  '--widget-warning-bg': 'rgba(245, 158, 11, 0.15)',
  '--widget-info': '#6b9fd4',
  '--widget-info-bg': 'rgba(107, 159, 212, 0.15)',
  '--widget-primary-text': '#ffffff',
  ...widgetStructure,
} as const;

const light: ThemeSchemeDefinition = {
  xterm: {
    palette: {
      background: '#f0ebe3', foreground: '#1c1612', cursor: '#c26d3a', cursorAccent: '#f0ebe3',
      selectionBackground: 'rgba(194, 109, 58, 0.18)', selectionForeground: undefined,
      selectionInactiveBackground: 'rgba(194, 109, 58, 0.10)', black: '#1c1612', red: '#b83030',
      green: '#1d7a4e', yellow: '#a85a00', blue: '#3568a0', magenta: '#8f5a8a', cyan: '#2a7560',
      white: '#6f6156', brightBlack: '#a69a90', brightRed: '#c74040', brightGreen: '#2d8a5e',
      brightYellow: '#b87010', brightBlue: '#4a7ab5', brightMagenta: '#a070a0',
      brightCyan: '#3d8a75', brightWhite: '#2e2825',
    },
    fontFamily: xtermFont,
    fontSize: 14,
    lineHeight: 1.3,
  },
  monaco: {
    name: 'warm-light',
    fontFamily: fontCode,
    fontSize: 14,
    lineHeight: 22,
    data: {
      base: 'vs', inherit: true,
      rules: [
        { token: 'comment', foreground: '9ea1a7', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'a626a4' }, { token: 'keyword.control', foreground: 'a626a4' },
        { token: 'storage', foreground: 'a626a4' }, { token: 'storage.type', foreground: 'a626a4' },
        { token: 'string', foreground: '50a14f' }, { token: 'string.quoted', foreground: '50a14f' },
        { token: 'number', foreground: 'b76b01' }, { token: 'constant', foreground: 'b76b01' },
        { token: 'constant.numeric', foreground: 'b76b01' }, { token: 'type', foreground: 'b76b01' },
        { token: 'type.identifier', foreground: 'b76b01' }, { token: 'class', foreground: 'b76b01' },
        { token: 'function', foreground: '4078f2' }, { token: 'function.call', foreground: '4078f2' },
        { token: 'variable', foreground: '4078f2' }, { token: 'variable.other', foreground: '4078f2' },
        { token: 'operator', foreground: '4078f2' }, { token: 'tag', foreground: 'e45649' },
        { token: 'attribute.name', foreground: 'b76b01' }, { token: 'attribute.value', foreground: '50a14f' },
        { token: 'delimiter', foreground: '383a42' }, { token: 'delimiter.bracket', foreground: '383a42' },
      ],
      colors: {
        'editor.background': '#f8f5ef', 'editor.foreground': '#383a42',
        'editor.lineHighlightBackground': '#f3f0ea', 'editor.selectionBackground': '#e5e5e6',
        'editor.inactiveSelectionBackground': '#f0ede6', 'editorLineNumber.foreground': '#9ea1a7',
        'editorLineNumber.activeForeground': '#383a42', 'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#c8b8a840', 'scrollbarSlider.hoverBackground': '#b8a08860',
        'scrollbarSlider.activeBackground': '#a0906880', 'editorGutter.background': '#f8f5ef',
        'editorCursor.foreground': '#383a42', 'editorIndentGuide.background': '#e8e4db',
        'editorIndentGuide.activeBackground': '#d8d4cb',
      },
    },
  },
  mermaid: {
    theme: 'neutral', fontFamily: mermaidFont,
    themeVariables: {
      primaryColor: '#e8ddd0', primaryTextColor: '#1c1612', primaryBorderColor: '#c4b5a5',
      lineColor: '#8a7a6a', secondaryColor: '#f5efe8', tertiaryColor: '#fff8f0',
    },
  },
  prism: createPrismStyle({
    background: '#f3ede4',
    text: '#2e2825',
    textSecondary: '#6f6156',
    muted: '#8b7d70',
    accent: '#c26d3a',
    success: '#2d8a5e',
    error: '#dc2626',
    warning: '#d97706',
    info: '#4a7ab5',
    cool: '#2e6f5e',
  }),
  widget: { variables: lightWidgetVariables },
};

const dark: ThemeSchemeDefinition = {
  xterm: {
    palette: {
      background: '#1a1614', foreground: '#d4c8bc', cursor: '#c26d3a', cursorAccent: '#1a1614',
      selectionBackground: 'rgba(194, 109, 58, 0.25)', selectionForeground: undefined,
      selectionInactiveBackground: 'rgba(194, 109, 58, 0.15)', black: '#2a2420', red: '#c75050',
      green: '#2d8a5e', yellow: '#d97706', blue: '#4a7ab5', magenta: '#b07aab', cyan: '#3d8a75',
      white: '#d4c8bc', brightBlack: '#6f6156', brightRed: '#e06060', brightGreen: '#3da872',
      brightYellow: '#f0a030', brightBlue: '#6a9ad0', brightMagenta: '#c894c2',
      brightCyan: '#4da88a', brightWhite: '#efe8e0',
    },
    fontFamily: xtermFont,
    fontSize: 14,
    lineHeight: 1.3,
  },
  monaco: {
    name: 'warm-dark',
    fontFamily: fontCode,
    fontSize: 14,
    lineHeight: 22,
    data: {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '685c52', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c678dd' }, { token: 'keyword.control', foreground: 'c678dd' },
        { token: 'storage', foreground: 'c678dd' }, { token: 'storage.type', foreground: 'c678dd' },
        { token: 'string', foreground: '98c379' }, { token: 'string.quoted', foreground: '98c379' },
        { token: 'number', foreground: 'd19a66' }, { token: 'constant', foreground: 'd19a66' },
        { token: 'constant.numeric', foreground: 'd19a66' }, { token: 'type', foreground: 'e5c07b' },
        { token: 'type.identifier', foreground: 'e5c07b' }, { token: 'class', foreground: 'e5c07b' },
        { token: 'function', foreground: '61afef' }, { token: 'function.call', foreground: '61afef' },
        { token: 'variable', foreground: 'e06c75' }, { token: 'variable.other', foreground: 'e06c75' },
        { token: 'operator', foreground: '56b6c2' }, { token: 'tag', foreground: 'e06c75' },
        { token: 'attribute.name', foreground: 'd19a66' }, { token: 'attribute.value', foreground: '98c379' },
        { token: 'delimiter', foreground: 'abb2bf' }, { token: 'delimiter.bracket', foreground: 'abb2bf' },
      ],
      colors: {
        'editor.background': '#141210', 'editor.foreground': '#d4d4d4',
        'editor.lineHighlightBackground': '#1e1a16', 'editor.selectionBackground': '#3a342c',
        'editor.inactiveSelectionBackground': '#302a22', 'editorLineNumber.foreground': '#685c52',
        'editorLineNumber.activeForeground': '#cfc5ba', 'scrollbar.shadow': '#00000000',
        'scrollbarSlider.background': '#4a403840', 'scrollbarSlider.hoverBackground': '#5a504860',
        'scrollbarSlider.activeBackground': '#6a605880', 'editorGutter.background': '#141210',
        'editorCursor.foreground': '#e4dcd4', 'editorIndentGuide.background': '#2a2420',
        'editorIndentGuide.activeBackground': '#3a342c',
      },
    },
  },
  mermaid: {
    theme: 'dark', fontFamily: mermaidFont,
    themeVariables: {
      primaryColor: '#3a3230', primaryTextColor: '#e8dccf', primaryBorderColor: '#5a4f48',
      lineColor: '#8a7a6a', secondaryColor: '#2a2420', tertiaryColor: '#1e1a18',
    },
  },
  prism: createPrismStyle({
    background: '#141210',
    text: '#d4c8bc',
    textSecondary: '#cfc5ba',
    muted: '#7f7368',
    accent: '#d4803f',
    success: '#4aad7a',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#6b9fd4',
    cool: '#4aad8a',
  }),
  widget: { variables: darkWidgetVariables },
};

const noHeroBackground = {
  assetUrl: null,
  position: 'center',
  size: 'cover',
  repeat: 'no-repeat',
  mask: null,
} as const;

export const myAgentsDefaultTheme: ThemeDefinition = {
  id: 'myagents-default',
  displayName: `${APP_DISPLAY_NAME} Classic`,
  description: `${APP_DISPLAY_NAME} warm paper / warm night visual language`,
  stylesheetText,
  hero: {
    productName: APP_DISPLAY_NAME,
    slogans: {
      'zh-CN': APP_BUILD_PROFILE === 'moxbot' ? '人定目标，Bot 团队协作执行' : '每个人都应享受智能的推背感，欢迎来到言出法随的世界',
      'en-US': APP_BUILD_PROFILE === 'moxbot' ? 'Set goals. Let your Bot team get to work.' : 'Your intent, amplified',
    },
    backgrounds: { light: noHeroBackground, dark: noHeroBackground },
  },
  schemes: { light, dark },
};
