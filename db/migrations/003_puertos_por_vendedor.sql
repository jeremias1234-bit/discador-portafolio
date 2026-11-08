-- 003: puertos por vendedor (2026-10-27).
--   Ej.: 25 puertos y 5 vendedores = hasta 5 llamadas simultáneas por vendedor libre.
--   puertos_por_vendedor_auto = true: el motor reparte los puertos de la campaña entre los
--   vendedores asignados con la línea conectada. false: vale llamadas_por_vendedor (o el global).
ALTER TABLE campanas ADD COLUMN puertos_por_vendedor_auto BOOLEAN NOT NULL DEFAULT false;
