/**
 * TabBar - Drag-and-drop sortable tab bar with horizontal scroll
 * 
 * Features:
 * - Horizontal scroll when tabs overflow
 * - Fade gradients at edges to indicate hidden content
 * - Hides + button when at MAX_TABS
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';

import SortableTabItem from '@/components/SortableTabItem';
import { type Tab, MAX_TABS } from '@/types/tab';

interface TabBarProps {
    tabs: Tab[];
    activeTabId: string | null;
    onSelectTab: (tabId: string) => void;
    onCloseTab: (tabId: string) => void;
    onNewTab: () => void;
    onReorderTabs: (activeId: string, overId: string) => void;
}

export default function TabBar({
    tabs,
    activeTabId,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onReorderTabs,
}: TabBarProps) {
    const canAddTab = tabs.length < MAX_TABS;
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // Track scroll state for fade indicators
    const [scrollState, setScrollState] = useState({
        canScrollLeft: false,
        canScrollRight: false
    });

    // Check scroll position and update fade indicators
    const updateScrollState = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const { scrollLeft, scrollWidth, clientWidth } = container;
        setScrollState({
            canScrollLeft: scrollLeft > 0,
            canScrollRight: scrollLeft + clientWidth < scrollWidth - 1, // -1 for rounding
        });
    }, []);

    // Update scroll state on mount, resize, and tab changes
    useEffect(() => {
        updateScrollState();

        const container = scrollContainerRef.current;
        if (!container) return;

        container.addEventListener('scroll', updateScrollState);
        window.addEventListener('resize', updateScrollState);

        return () => {
            container.removeEventListener('scroll', updateScrollState);
            window.removeEventListener('resize', updateScrollState);
        };
    }, [updateScrollState, tabs.length]);

    // Auto-scroll to active tab when it changes (e.g., when adding new tab)
    useEffect(() => {
        if (!activeTabId) return;

        const container = scrollContainerRef.current;
        if (!container) return;

        // Find the active tab element and scroll it into view
        const activeTabElement = container.querySelector(`[data-tab-id="${activeTabId}"]`);
        if (activeTabElement) {
            activeTabElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            // Update scroll state after scroll animation
            setTimeout(updateScrollState, 300);
        }
    }, [activeTabId, updateScrollState]);

    // Configure sensors for drag detection
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // Handle drag end
    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            onReorderTabs(active.id as string, over.id as string);
        }
    };

    return (
        <div className="flex h-full flex-1 items-center gap-0.5 select-none overflow-hidden">
            {/* Scroll container with fade indicators */}
            <div className="relative flex-1 overflow-hidden">
                {/* Left fade gradient */}
                {scrollState.canScrollLeft && (
                    <div
                        className="absolute left-0 top-0 bottom-0 w-6 z-10 pointer-events-none"
                        style={{
                            background: 'linear-gradient(to right, var(--paper) 0%, transparent 100%)',
                        }}
                    />
                )}

                {/* Right fade gradient */}
                {scrollState.canScrollRight && (
                    <div
                        className="absolute right-0 top-0 bottom-0 w-6 z-10 pointer-events-none"
                        style={{
                            background: 'linear-gradient(to left, var(--paper) 0%, transparent 100%)',
                        }}
                    />
                )}

                {/* Sortable tab list */}
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={tabs.map(t => t.id)}
                        strategy={horizontalListSortingStrategy}
                    >
                        <div
                            ref={scrollContainerRef}
                            className="flex items-center gap-0.5 overflow-x-auto scrollbar-none"
                            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                        >
                            {tabs.map((tab) => (
                                <SortableTabItem
                                    key={tab.id}
                                    tab={tab}
                                    isActive={tab.id === activeTabId}
                                    onSelect={() => onSelectTab(tab.id)}
                                    onClose={() => onCloseTab(tab.id)}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            </div>

            {/* New tab button - hidden when at max tabs */}
            {canAddTab && (
                <button
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-all duration-150 text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]/60 hover:text-[var(--ink)]"
                    onClick={onNewTab}
                    title="新建标签页"
                >
                    <Plus className="h-4 w-4" />
                </button>
            )}
        </div>
    );
}
