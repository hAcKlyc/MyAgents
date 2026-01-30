/**
 * BrandSection - Left panel of the Launcher page
 * Displays brand name and slogan with minimalist tech style
 */

export default function BrandSection() {
    return (
        <section className="flex flex-1 flex-col items-center justify-center px-12">
            {/* Brand Name */}
            <h1 className="brand-title mb-5 text-[3.5rem] font-light tracking-tight text-[var(--ink)] md:text-[4.5rem]">
                MyAgents
            </h1>

            {/* Slogan - English */}
            <p className="brand-slogan text-center text-[15px] font-light tracking-[0.06em] text-[var(--ink-secondary)] md:text-[17px]">
                Your Universal AI Assistant
            </p>

            {/* Slogan - Chinese */}
            <p className="mt-2.5 text-center text-[13px] font-normal tracking-[0.08em] text-[var(--ink-muted)]/70 md:text-[14px]">
                让每个人都有一个智能助手
            </p>
        </section>
    );
}
