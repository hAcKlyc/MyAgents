import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ImagePreviewProps {
    src: string;
    name: string;
    onClose: () => void;
}

export default function ImagePreview({ src, name, onClose }: ImagePreviewProps) {
    const [scale, setScale] = useState(1);
    const [rotation, setRotation] = useState(0);

    // Close on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const handleZoomIn = useCallback(() => {
        setScale((s) => Math.min(s + 0.25, 3));
    }, []);

    const handleZoomOut = useCallback(() => {
        setScale((s) => Math.max(s - 0.25, 0.25));
    }, []);

    const handleReset = useCallback(() => {
        setScale(1);
        setRotation(0);
    }, []);

    const handleRotate = useCallback(() => {
        setRotation((r) => (r + 90) % 360);
    }, []);

    // Prevent background scroll when modal is open
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, []);

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={onClose}
        >
            {/* Header with title and controls */}
            <div
                className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4"
                onClick={(e) => e.stopPropagation()}
            >
                <span className="text-sm font-medium text-white/90 truncate max-w-[50%]">{name}</span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleZoomOut}
                        className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title="缩小"
                    >
                        <ZoomOut className="h-5 w-5" />
                    </button>
                    <span className="text-xs text-white/60 min-w-[3rem] text-center">{Math.round(scale * 100)}%</span>
                    <button
                        type="button"
                        onClick={handleZoomIn}
                        className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title="放大"
                    >
                        <ZoomIn className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        onClick={handleRotate}
                        className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title="旋转"
                    >
                        <RotateCcw className="h-5 w-5" style={{ transform: 'scaleX(-1)' }} />
                    </button>
                    <button
                        type="button"
                        onClick={handleReset}
                        className="rounded-lg px-3 py-2 text-xs text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title="重置"
                    >
                        重置
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-4 rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title="关闭 (Esc)"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>
            </div>

            {/* Image container */}
            <div
                className="relative flex items-center justify-center"
                onClick={(e) => e.stopPropagation()}
            >
                <img
                    src={src}
                    alt={name}
                    className="max-h-[80vh] max-w-[90vw] rounded-lg shadow-2xl transition-transform duration-200"
                    style={{
                        transform: `scale(${scale}) rotate(${rotation}deg)`,
                    }}
                    draggable={false}
                />
            </div>

            {/* Hint text */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/50">
                双击图片放大 · 按 Esc 关闭
            </div>
        </div>,
        document.body
    );
}
