import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PrinterStatus, Printer } from '../api/client';
import {
  buildAmsMapping,
  buildFilamentComparison,
  buildLoadedFilaments,
  computeAmsMapping,
  type FilamentComparison,
  type LoadedFilament,
  type FilamentRequirement,
} from './useFilamentMapping';
import { effectivePreferLowest } from '../utils/amsHelpers';

/**
 * Match status for a single printer's filament configuration.
 */
export type PrinterMatchStatus = 'full' | 'partial' | 'missing';

/**
 * Per-printer configuration for AMS mapping.
 */
export interface PerPrinterConfig {
  /** Whether this printer is auto-matched on its own trays (true) or uses the
   *  custom `manualMappings` below (false) */
  useDefault: boolean;
  /** Manual slot overrides for this printer (slot_id -> globalTrayId) */
  manualMappings: Record<number, number>;
  /** Whether this mapping was auto-configured */
  autoConfigured: boolean;
}

/**
 * Result of filament mapping for a single printer.
 */
export interface PrinterMappingResult {
  printerId: number;
  printerName: string;
  /** Printer status data */
  status: PrinterStatus | undefined;
  /** Whether status is still loading */
  isLoading: boolean;
  /** List of loaded filaments in this printer */
  loadedFilaments: LoadedFilament[];
  /** Auto-computed AMS mapping for this printer */
  autoMapping: number[] | undefined;
  /** Final AMS mapping (considering manual overrides). This is what gets
   *  dispatched to THIS printer; undefined until its trays are known, which
   *  leaves the mapping to the scheduler at dispatch. */
  finalMapping: number[] | undefined;
  /** Per-slot outcome behind `finalMapping`, so the editor shows the tray that
   *  is actually sent rather than re-matching on its own. */
  filamentComparison: FilamentComparison[];
  /** Match status: full (all exact), partial (some mismatches), missing (type not found) */
  matchStatus: PrinterMatchStatus;
  /** Number of slots with exact match (type + color) */
  exactMatches: number;
  /** Number of slots with type-only match */
  typeOnlyMatches: number;
  /** Number of slots with missing type */
  missingTypes: number;
  /** Total required slots */
  totalSlots: number;
  /** Per-printer config */
  config: PerPrinterConfig;
  /** Per-globalTrayId inventory grams remaining, for the lowest-remain sort (#1766) */
  inventoryByTrayId?: Map<number, number>;
}

/**
 * Result of the useMultiPrinterFilamentMapping hook.
 */
export interface UseMultiPrinterFilamentMappingResult {
  /** Results for each selected printer */
  printerResults: PrinterMappingResult[];
  /** Whether any printer data is still loading */
  isLoading: boolean;
  /** Per-printer configurations */
  perPrinterConfigs: Record<number, PerPrinterConfig>;
  /** Update config for a specific printer */
  updatePrinterConfig: (printerId: number, config: Partial<PerPrinterConfig>) => void;
  /** Auto-configure all printers based on their loaded filaments */
  autoConfigureAll: () => void;
  /** Auto-configure a specific printer */
  autoConfigurePrinter: (printerId: number) => void;
  /** Get final mapping for a specific printer (for submission) */
  getFinalMapping: (printerId: number) => number[] | undefined;
  /** Check if all printers have acceptable mappings */
  allPrintersReady: boolean;
}

/**
 * Default per-printer config (auto-match on the printer's own trays).
 */
const DEFAULT_PRINTER_CONFIG: PerPrinterConfig = {
  useDefault: true,
  manualMappings: {},
  autoConfigured: false,
};

/**
 * Hook to manage filament mapping for multiple printers.
 * Fetches printer status for all selected printers and computes per-printer mappings.
 *
 * Every printer is matched on its own trays only. A global tray id names a spool
 * on the printer it was read from and nothing else — tray 0 can be red on one
 * printer and black on the next — so no mapping, auto or manual, is ever carried
 * from one printer to another. Matching runs through the same
 * `buildFilamentComparison` as the single-printer panel and the scheduler's
 * `_match_filaments_to_slots`, so a printer gets the same trays whether it is
 * picked alone or as part of a fan-out.
 */
export function useMultiPrinterFilamentMapping(
  selectedPrinterIds: number[],
  printers: Printer[] | undefined,
  filamentReqs: { filaments: FilamentRequirement[] } | undefined,
  perPrinterConfigs: Record<number, PerPrinterConfig>,
  setPerPrinterConfigs: React.Dispatch<React.SetStateAction<Record<number, PerPrinterConfig>>>,
  preferLowest?: boolean,
  inventoryByTrayIdPerPrinter?: Map<number, Map<number, number>>,
): UseMultiPrinterFilamentMappingResult {
  // Fetch printer status for all selected printers in parallel
  const statusQueries = useQueries({
    queries: selectedPrinterIds.map((printerId) => ({
      queryKey: ['printer-status', printerId],
      queryFn: () => api.getPrinterStatus(printerId),
      enabled: selectedPrinterIds.length > 0,
      staleTime: 5000, // Consider data fresh for 5 seconds
    })),
  });

  // Build results for each printer
  const printerResults = useMemo((): PrinterMappingResult[] => {
    return selectedPrinterIds.map((printerId, index) => {
      const query = statusQueries[index];
      const printerStatus = query?.data;
      const printer = printers?.find((p) => p.id === printerId);
      const printerName = printer?.name || `Printer ${printerId}`;

      const loadedFilaments = buildLoadedFilaments(printerStatus);
      const config = perPrinterConfigs[printerId] || DEFAULT_PRINTER_CONFIG;
      const inventoryByTrayId = inventoryByTrayIdPerPrinter?.get(printerId);
      // Per-printer gate (#1766): two printers in the same dispatch can have
      // different AMS Backup states; the sort must be skipped on the OFF ones
      // and kept on the ON ones. Computing inside the loop captures both.
      const printerPreferLowest = effectivePreferLowest(preferLowest, printerStatus?.ams_filament_backup);

      // FTS routes any AMS slot to any extruder, so per-nozzle slot restriction
      // doesn't apply when it's installed (#1162).
      const ftsActive = printerStatus?.fila_switch?.installed === true;

      // Compute auto mapping for this printer
      const autoMapping = computeAmsMapping(filamentReqs, printerStatus, printerPreferLowest, inventoryByTrayId);

      // Only this printer's own overrides apply. The shared panel's mappings
      // were picked against another printer's trays and mean nothing here.
      const manualMappings = config.useDefault ? {} : config.manualMappings;

      const filamentComparison = buildFilamentComparison(
        filamentReqs,
        loadedFilaments,
        manualMappings,
        printerPreferLowest,
        inventoryByTrayId,
        ftsActive,
      );

      // No trays known yet: send no mapping and let the scheduler resolve it from
      // live status at dispatch, rather than an all-[-1] array (#2589).
      const finalMapping = loadedFilaments.length === 0 ? undefined : buildAmsMapping(filamentComparison);

      const exactMatches = filamentComparison.filter((f) => f.status === 'match').length;
      const typeOnlyMatches = filamentComparison.filter((f) => f.status === 'type_only').length;
      const missingTypes = filamentComparison.filter((f) => f.status === 'mismatch').length;
      let matchStatus: PrinterMatchStatus = 'full';
      if (missingTypes > 0) {
        matchStatus = 'missing';
      } else if (typeOnlyMatches > 0) {
        matchStatus = 'partial';
      }

      return {
        printerId,
        printerName,
        status: printerStatus,
        isLoading: query?.isLoading ?? false,
        loadedFilaments,
        autoMapping,
        finalMapping,
        filamentComparison,
        matchStatus,
        exactMatches,
        typeOnlyMatches,
        missingTypes,
        totalSlots: filamentComparison.length,
        config,
        inventoryByTrayId,
      };
    });
  }, [selectedPrinterIds, statusQueries, printers, filamentReqs, perPrinterConfigs, preferLowest, inventoryByTrayIdPerPrinter]);

  const isLoading = statusQueries.some((q) => q.isLoading);

  // Update config for a specific printer
  const updatePrinterConfig = (printerId: number, updates: Partial<PerPrinterConfig>) => {
    setPerPrinterConfigs((prev) => ({
      ...prev,
      [printerId]: {
        ...(prev[printerId] || DEFAULT_PRINTER_CONFIG),
        ...updates,
      },
    }));
  };

  // Auto-configure a specific printer based on its loaded filaments
  const autoConfigurePrinter = (printerId: number) => {
    const result = printerResults.find((r) => r.printerId === printerId);
    if (!result || !result.status || !filamentReqs?.filaments) return;

    // Compute optimal mapping for this printer
    const autoMapping = computeAmsMapping(
      filamentReqs,
      result.status,
      effectivePreferLowest(preferLowest, result.status?.ams_filament_backup),
      inventoryByTrayIdPerPrinter?.get(printerId),
    );
    if (!autoMapping) return;

    // Convert autoMapping array to manualMappings record
    const manualMappings: Record<number, number> = {};
    autoMapping.forEach((globalTrayId, index) => {
      if (globalTrayId !== -1) {
        manualMappings[index + 1] = globalTrayId;
      }
    });

    updatePrinterConfig(printerId, {
      useDefault: false,
      manualMappings,
      autoConfigured: true,
    });
  };

  // Auto-configure all printers
  const autoConfigureAll = () => {
    for (const printerId of selectedPrinterIds) {
      autoConfigurePrinter(printerId);
    }
  };

  // Get final mapping for a specific printer (for submission)
  const getFinalMapping = (printerId: number): number[] | undefined => {
    const result = printerResults.find((r) => r.printerId === printerId);
    return result?.finalMapping;
  };

  // Check if all printers have acceptable mappings (no missing types)
  const allPrintersReady = printerResults.every((r) => r.matchStatus !== 'missing');

  return {
    printerResults,
    isLoading,
    perPrinterConfigs,
    updatePrinterConfig,
    autoConfigureAll,
    autoConfigurePrinter,
    getFinalMapping,
    allPrintersReady,
  };
}
