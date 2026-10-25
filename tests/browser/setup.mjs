import { build } from 'esbuild';
import { options } from '../../scripts/build.mjs';

export default async function setup() { await build(options); }
