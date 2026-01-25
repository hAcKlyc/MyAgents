import { Upload } from 'lucide-react';

interface DropZoneOverlayProps {
  /** Whether the overlay is visible */
  isVisible: boolean;
  /** Message to display in the overlay */
  message?: string;
  /** Optional subtitle for additional context */
  subtitle?: string;
}

/**
 * Full-screen drag overlay that appears when files are being dragged over a drop zone
 *
 * Shows a visual indicator with an upload icon and message to guide users
 * on where to drop their files.
 */
export default function DropZoneOverlay({
  isVisible,
  message = '松手将文件加入工作区',
  subtitle,
}: DropZoneOverlayProps) {
  if (!isVisible) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-[var(--paper-strong)]/90 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[var(--paper)]/80 px-12 py-8 shadow-2xl">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <Upload className="h-8 w-8 text-[var(--accent)]" />
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-[var(--ink)]">{message}</p>
          {subtitle && (
            <p className="mt-1 text-sm text-[var(--ink-muted)]">{subtitle}</p>
          )}
        </div>
      </div>
    </div>
  );
}
