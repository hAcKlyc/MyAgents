/**
 * BrandSection - Left panel of the Launcher page
 * Displays brand name and slogan with minimalist tech style
 */

export default function BrandSection() {
    return (
        <section className="flex flex-1 flex-col items-center justify-center px-12">
            {/* Brand Name */}
            <h1 className="brand-title mb-6 text-[3.5rem] font-light tracking-tight text-[var(--ink)] md:text-[4.5rem]">
                MyAgents
            </h1>

            {/* Slogan - English */}
            <p className="brand-slogan text-center text-base font-light tracking-wide text-[var(--ink-secondary)] md:text-lg">
                Your Universal AI Assistant
            </p>

            {/* Slogan - Chinese */}
            <p className="mt-3 text-center text-sm font-normal tracking-wider text-[var(--ink-muted)] md:text-base">
                让每个人都有一个智能助手
            </p>
        </section>
    );
}
