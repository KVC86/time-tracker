-- IdleTracker integration: a new violation type recorded when a floor-level
-- employee is auto-clocked-out because the desktop agent reported them idle.
-- Additive enum value; no existing rows or code paths are affected.
ALTER TYPE "ViolationType" ADD VALUE 'IDLE_TIMEOUT';
