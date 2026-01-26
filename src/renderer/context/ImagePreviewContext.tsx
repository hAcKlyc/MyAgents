import { createContext, useContext, useCallback, useState, useMemo } from 'react';
import type { ReactNode } from 'react';

import ImagePreview from '@/components/ImagePreview';

interface PreviewState {
    src: string;
    name: string;
}

interface ImagePreviewContextValue {
    openPreview: (src: string, name: string) => void;
    closePreview: () => void;
}

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
    const [preview, setPreview] = useState<PreviewState | null>(null);

    const openPreview = useCallback((src: string, name: string) => {
        setPreview({ src, name });
    }, []);

    const closePreview = useCallback(() => {
        setPreview(null);
    }, []);

    // Memoize context value to prevent unnecessary re-renders of consumers
    const contextValue = useMemo(() => ({
        openPreview, closePreview
    }), [openPreview, closePreview]);

    return (
        <ImagePreviewContext.Provider value={contextValue}>
            {children}
            {preview && (
                <ImagePreview
                    src={preview.src}
                    name={preview.name}
                    onClose={closePreview}
                />
            )}
        </ImagePreviewContext.Provider>
    );
}

export function useImagePreview(): ImagePreviewContextValue {
    const context = useContext(ImagePreviewContext);
    if (!context) {
        throw new Error('useImagePreview must be used within an ImagePreviewProvider');
    }
    return context;
}
