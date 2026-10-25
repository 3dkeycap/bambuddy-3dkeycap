/**
 * Tests for useMultiPrinterFilamentMapping.
 *
 * A fan-out across several printers has to map each printer on its own trays:
 * a global tray id names a spool on the printer it was read from and nothing
 * else. These tests pin that, and that a fan-out printer is matched by the same
 * rules as a printer picked on its own (tray_info_idx first, hard nozzle filter).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { server } from '../mocks/server';
import {
  useMultiPrinterFilamentMapping,
  type PerPrinterConfig,
} from '../../hooks/useMultiPrinterFilamentMapping';
import type { FilamentRequirement } from '../../hooks/useFilamentMapping';
import type { Printer } from '../../api/client';

type Tray = { id: number; tray_type: string; tray_color: string; tray_info_idx?: string };
type Status = {
  ams: Array<{ id: number; tray: Tray[] }>;
  vt_tray?: unknown[];
  ams_extruder_map?: Record<string, number>;
  fila_switch?: { installed: boolean };
};

const PRINTERS = [
  { id: 1, name: 'Printer 1' },
  { id: 2, name: 'Printer 2' },
] as Printer[];

function renderMapping(
  selected: number[],
  reqs: FilamentRequirement[],
  initialConfigs: Record<number, PerPrinterConfig> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const filamentReqs = { filaments: reqs };
  return renderHook(
    () => {
      const [configs, setConfigs] = useState(initialConfigs);
      return useMultiPrinterFilamentMapping(selected, PRINTERS, filamentReqs, configs, setConfigs);
    },
    { wrapper },
  );
}

function serveStatuses(byPrinter: Record<string, Status | null>) {
  server.use(
    http.get('/api/v1/printers/:id/status', ({ params }) => {
      const status = byPrinter[String(params.id)];
      // null = a printer whose status never arrives during the test.
      if (status === null) return new Promise<never>(() => {});
      return HttpResponse.json({ connected: true, state: 'IDLE', vt_tray: [], ...status });
    }),
  );
}

const req = (overrides: Partial<FilamentRequirement>): FilamentRequirement => ({
  slot_id: 1,
  type: 'PLA',
  color: '#FF0000',
  used_grams: 10,
  ...overrides,
});

describe('useMultiPrinterFilamentMapping', () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  it('maps every printer on its own trays', async () => {
    serveStatuses({
      '1': { ams: [{ id: 0, tray: [
        { id: 0, tray_type: 'PLA', tray_color: 'FF0000' },
        { id: 1, tray_type: 'PLA', tray_color: '000000' },
      ] }] },
      '2': { ams: [{ id: 0, tray: [
        { id: 0, tray_type: 'PLA', tray_color: '000000' },
        { id: 1, tray_type: 'PLA', tray_color: 'FF0000' },
      ] }] },
    });

    const { result } = renderMapping([1, 2], [
      req({ slot_id: 1, color: '#FF0000' }),
      req({ slot_id: 2, color: '#000000' }),
    ]);

    await waitFor(() => expect(result.current.getFinalMapping(2)).toBeDefined());
    expect(result.current.getFinalMapping(1)).toEqual([0, 1]);
    expect(result.current.getFinalMapping(2)).toEqual([1, 0]);
    expect(result.current.printerResults.map((r) => r.matchStatus)).toEqual(['full', 'full']);
  });

  it('keeps one printer\'s custom mapping off the other printers', async () => {
    const status: Status = { ams: [{ id: 0, tray: [
      { id: 0, tray_type: 'PLA', tray_color: 'FF0000' },
      { id: 1, tray_type: 'PLA', tray_color: '000000' },
    ] }] };
    serveStatuses({ '1': status, '2': status });

    // Printer 2 is forced onto the black tray; printer 1 is left on auto.
    const { result } = renderMapping([1, 2], [req({ slot_id: 1, color: '#FF0000' })], {
      2: { useDefault: false, manualMappings: { 1: 1 }, autoConfigured: false },
    });

    await waitFor(() => expect(result.current.getFinalMapping(1)).toBeDefined());
    expect(result.current.getFinalMapping(1)).toEqual([0]);
    expect(result.current.getFinalMapping(2)).toEqual([1]);
    expect(result.current.printerResults[1].matchStatus).toBe('partial');
  });

  it('prefers the sliced variant (tray_info_idx) like the single-printer matcher', async () => {
    // Two red PLA spools: Matte (GFA01) first, Basic (GFA00) second. The slice
    // asked for Basic, so colour alone would pick the wrong variant (#2650).
    serveStatuses({
      '1': { ams: [{ id: 0, tray: [
        { id: 0, tray_type: 'PLA', tray_color: 'FF0000', tray_info_idx: 'GFA01' },
        { id: 1, tray_type: 'PLA', tray_color: 'FF0000', tray_info_idx: 'GFA00' },
      ] }] },
      '2': { ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000', tray_info_idx: 'GFA00' }] }] },
    });

    const { result } = renderMapping([1, 2], [req({ tray_info_idx: 'GFA00' })], {
      // A custom config that leaves the slot to auto still has to honour the idx.
      1: { useDefault: false, manualMappings: {}, autoConfigured: false },
    });

    await waitFor(() => expect(result.current.getFinalMapping(1)).toBeDefined());
    expect(result.current.getFinalMapping(1)).toEqual([1]);
    expect(result.current.printerResults[0].filamentComparison[0].loaded?.globalTrayId).toBe(1);
  });

  // Red PLA only sits behind the left nozzle (AMS 1 -> extruder 1); the right
  // nozzle's AMS holds PETG. The slot is sliced for the right nozzle.
  const DUAL_NOZZLE: Status = {
    ams: [
      { id: 0, tray: [{ id: 0, tray_type: 'PETG', tray_color: 'FFFFFF' }] },
      { id: 1, tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000' }] },
    ],
    ams_extruder_map: { '0': 0, '1': 1 },
  };

  it('never matches across nozzles on a dual-nozzle printer', async () => {
    serveStatuses({
      '1': DUAL_NOZZLE,
      '2': { ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000' }] }] },
    });

    const { result } = renderMapping([1, 2], [req({ nozzle_id: 0 })]);

    await waitFor(() => expect(result.current.getFinalMapping(1)).toBeDefined());
    // Cross-nozzle assignment fails the print, so the left red tray is never a
    // fallback: the slot stays unmapped and the printer is flagged.
    expect(result.current.getFinalMapping(1)).toEqual([-1]);
    expect(result.current.printerResults[0].matchStatus).toBe('missing');
    expect(result.current.allPrintersReady).toBe(false);
  });

  it('routes across nozzles when a Filament Track Switch is installed', async () => {
    serveStatuses({
      '1': { ...DUAL_NOZZLE, fila_switch: { installed: true } },
      '2': { ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000' }] }] },
    });

    const { result } = renderMapping([1, 2], [req({ nozzle_id: 0 })]);

    await waitFor(() => expect(result.current.getFinalMapping(1)).toBeDefined());
    expect(result.current.getFinalMapping(1)).toEqual([4]);
  });

  it('sends no mapping for a printer whose trays are not known yet', async () => {
    serveStatuses({
      '1': { ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000' }] }] },
      '2': null,
    });

    const { result } = renderMapping([1, 2], [req({})]);

    await waitFor(() => expect(result.current.getFinalMapping(1)).toEqual([0]));
    // Not [-1]: the scheduler resolves a missing mapping from live status (#2589).
    expect(result.current.getFinalMapping(2)).toBeUndefined();
  });

  it('auto-configures a printer from its own trays', async () => {
    serveStatuses({
      '1': { ams: [{ id: 0, tray: [
        { id: 0, tray_type: 'PLA', tray_color: 'FF0000' },
        { id: 1, tray_type: 'PLA', tray_color: '000000' },
      ] }] },
      '2': { ams: [{ id: 0, tray: [
        { id: 0, tray_type: 'PLA', tray_color: '000000' },
        { id: 1, tray_type: 'PLA', tray_color: 'FF0000' },
      ] }] },
    });

    const { result } = renderMapping([1, 2], [req({})]);
    await waitFor(() => expect(result.current.getFinalMapping(2)).toBeDefined());

    act(() => result.current.autoConfigureAll());

    await waitFor(() => expect(result.current.perPrinterConfigs[2]?.useDefault).toBe(false));
    expect(result.current.perPrinterConfigs[1].manualMappings).toEqual({ 1: 0 });
    expect(result.current.perPrinterConfigs[2].manualMappings).toEqual({ 1: 1 });
    expect(result.current.getFinalMapping(2)).toEqual([1]);
  });
});
