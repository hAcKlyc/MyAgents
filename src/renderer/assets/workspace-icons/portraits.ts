import star from './portraits/star.png';
import bean from './portraits/bean.png';
import arch from './portraits/arch.png';
import cloud from './portraits/cloud.png';
import softSquare from './portraits/soft-square.png';
import crescent from './portraits/crescent.png';
import triangle from './portraits/triangle.png';
import wave from './portraits/wave.png';
import droplet from './portraits/droplet.png';

/** Opt-in Agent portraits. IDs share the existing project.icon persistence path. */
export const WORKSPACE_ICON_PORTRAITS = {
    'companion-star': { src: star },
    'companion-bean': { src: bean },
    'companion-arch': { src: arch },
    'companion-cloud': { src: cloud },
    'companion-soft-square': { src: softSquare },
    'companion-crescent': { src: crescent },
    'companion-triangle': { src: triangle },
    'companion-wave': { src: wave },
    'companion-droplet': { src: droplet },
} as const;
