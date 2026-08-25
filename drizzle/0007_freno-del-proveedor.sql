-- Cuándo vuelve a poder enviar una cuenta que el proveedor ha frenado.
--
-- LinkedIn contesta "You have reached a temporary provider limit" cuando la
-- cuenta ha invitado por encima de su tope semanal. Se leía como "esa persona
-- ya tiene la invitación" y el lead se marcaba contactado: 62 prospectos
-- salieron de la cola sin haber recibido nada, y los 20 intentos del día se
-- gastaban contra la misma pared uno detrás de otro.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "throttled_until" timestamptz;
