import { vi } from 'vitest';

// Silence console methods during tests to keep output clean.
// Spying on them allows tests to still assert that they were called.
vi.spyOn(console, 'log').mockImplementation(() => { /* Silence */ });
vi.spyOn(console, 'error').mockImplementation(() => { /* Silence */ });
vi.spyOn(console, 'warn').mockImplementation(() => { /* Silence */ });
vi.spyOn(console, 'info').mockImplementation(() => { /* Silence */ });
vi.spyOn(console, 'debug').mockImplementation(() => { /* Silence */ });
