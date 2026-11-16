import { useEffect, useMemo, useState, type Dispatch } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, AlertTriangle } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useActiveRutina, useApplyRutinaEdits } from '@/hooks/useAdminRutina';
import { useAlerts } from '@/hooks/useAlerts';
import type { AddedSlotData } from '@/components/admin/rutinas/AddSlotPopover';
import type { SlotOverride } from '@/components/admin/rutinas/EditSlotPopover';
import type { ApplyEditsInput, RutinaSlot } from '@/types/api';
import {
  DayCard,
  dayDragId,
  dayFromDragId,
  isDayDragId,
  remapDaysForMove,
} from './DayCard';
import { ChangeTrainingDaysDialog } from './ChangeTrainingDaysDialog';
import { SetProgramWeekDialog } from './SetProgramWeekDialog';

export function DetailPaneActivas({
  athleteId,
  onDirtyChange,
}: {
  athleteId: string;
  onDirtyChange?: Dispatch<boolean>;
}) {
  const [daysOpen, setDaysOpen] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);
  const { data, isLoading, error } = useActiveRutina(athleteId);
  const rutina = data?.rutina ?? null;
  const pendingSkeletonId = data?.pending_skeleton_id ?? null;
  const applyEdits = useApplyRutinaEdits(athleteId);
  const [overrides, setOverrides] = useState<Record<string, SlotOverride>>({});
  const [order, setOrder] = useState<RutinaSlot[] | null>(null);
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [orderDirty, setOrderDirty] = useState(false);
  const [focusEdits, setFocusEdits] = useState<Record<number, string>>({});

  const hasDraftChanges =
    Object.keys(overrides).length > 0 ||
    deleted.size > 0 ||
    addedIds.size > 0 ||
    changedFocus().length > 0 ||
    orderDirty;

  useEffect(() => {
    onDirtyChange?.(hasDraftChanges);
    return () => onDirtyChange?.(false);
  }, [hasDraftChanges, onDirtyChange]);

  useEffect(() => {
    if (!hasDraftChanges) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasDraftChanges]);

  useEffect(() => {
    if (!hasDraftChanges) return;
    function guardLinkNavigation(event: MouseEvent) {
      const target = event.target;
      const anchor =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>('a[href]')
          : null;
      if (!anchor || anchor.target === '_blank') return;
      const destination = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (
        destination.pathname === current.pathname &&
        destination.search === current.search &&
        destination.hash === current.hash
      ) {
        return;
      }
      if (!window.confirm('Hay cambios sin guardar. ¿Descartarlos y salir?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    document.addEventListener('click', guardLinkNavigation, true);
    return () =>
      document.removeEventListener('click', guardLinkNavigation, true);
  }, [hasDraftChanges]);

  const serverSlots = useMemo(
    () =>
      [...(rutina?.slots ?? [])].sort(
        (a, b) => a.day_of_week - b.day_of_week || a.slot_index - b.slot_index
      ),
    [rutina]
  );

  const draftSlots = useMemo(
    () =>
      (order ?? serverSlots)
        .filter((slot) => !deleted.has(slot.id))
        .map((slot) => {
          const override = overrides[slot.id];
          if (!override) return slot;
          return {
            ...slot,
            exercise_id: override.exercise_id,
            exercise_name: override.exercise_name,
            muscle_group: override.muscle_group,
            notes: override.notes ?? null,
            ...('series' in override
              ? {
                  series: override.series,
                  reps: override.reps,
                  descanso: override.descanso,
                }
              : {}),
          };
        }),
    [deleted, order, overrides, serverSlots]
  );

  const editedSlotIds = useMemo(
    () => new Set([...Object.keys(overrides), ...addedIds]),
    [addedIds, overrides]
  );
  const { data: alertsData } = useAlerts({ status: 'open', athleteId });
  const flaggedExerciseIds = new Set<number>(
    (alertsData?.items ?? [])
      .filter((alert) => alert.type === 'sos_pain' && alert.exercise_id != null)
      .map((alert) => alert.exercise_id as number)
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Day cards and slots share one DndContext, and a day card's center beats
  // any slot's. Only ever collide a drag against droppables of its own kind.
  function collisionDetection(args: Parameters<typeof closestCenter>[0]) {
    const draggingDay = isDayDragId(String(args.active.id));
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => isDayDragId(String(container.id)) === draggingDay
      ),
    });
  }

  function resetDraft() {
    setOverrides({});
    setOrder(null);
    setDeleted(new Set());
    setAddedIds(new Set());
    setOrderDirty(false);
    setFocusEdits({});
  }

  function onEdit(slotId: string, payload: SlotOverride) {
    if (addedIds.has(slotId)) {
      setOrder((slots) =>
        (slots ?? []).map((slot) =>
          slot.id === slotId
            ? {
                ...slot,
                exercise_id: payload.exercise_id,
                exercise_name: payload.exercise_name,
                muscle_group: payload.muscle_group,
                notes: payload.notes ?? null,
                ...('series' in payload
                  ? {
                      series: payload.series ?? null,
                      reps: payload.reps ?? null,
                      descanso: payload.descanso ?? null,
                    }
                  : {}),
              }
            : slot
        )
      );
      return;
    }
    setOverrides((current) => ({ ...current, [slotId]: payload }));
  }

  function onFocusChange(dayOfWeek: number, focus: string) {
    setFocusEdits((current) => ({ ...current, [dayOfWeek]: focus }));
  }

  /** Staged labels that differ from what the server already has. */
  function changedFocus() {
    const serverFocus = new Map(
      (rutina?.days ?? []).map((day) => [day.day_of_week, day.focus ?? ''])
    );
    return Object.entries(focusEdits)
      .map(([day, focus]) => ({
        day_of_week: Number(day),
        focus: focus.trim(),
      }))
      .filter((day) => day.focus !== (serverFocus.get(day.day_of_week) ?? ''));
  }

  function onDelete(slotId: string) {
    setOverrides((current) => {
      const next = { ...current };
      delete next[slotId];
      return next;
    });
    if (addedIds.has(slotId)) {
      setOrder((slots) => (slots ?? []).filter((slot) => slot.id !== slotId));
      setAddedIds((ids) => {
        const next = new Set(ids);
        next.delete(slotId);
        return next;
      });
      return;
    }
    setDeleted((ids) => new Set(ids).add(slotId));
  }

  function onAdd(dayOfWeek: number, data: AddedSlotData) {
    const daySlots = draftSlots.filter(
      (slot) => slot.day_of_week === dayOfWeek
    );
    if (daySlots.length >= 12) {
      toast.error('Un día no puede tener más de 12 ejercicios');
      return;
    }
    const newSlot: RutinaSlot = {
      id: crypto.randomUUID(),
      day_of_week: dayOfWeek,
      slot_index: daySlots.length + 1,
      exercise_id: data.exercise_id,
      role: data.role,
      notes: data.notes ?? null,
      series: data.series ?? null,
      reps: data.reps ?? null,
      descanso: data.descanso ?? null,
      exercise_name: data.exercise_name,
      muscle_group: data.muscle_group,
    };
    setOrder((slots) => [...(slots ?? serverSlots), newSlot]);
    setAddedIds((ids) => new Set(ids).add(newSlot.id));
  }

  /**
   * Session ordinals, ascending. Reordering days rotates which day sits on
   * which ordinal — the ordinal itself never moves, the contents do.
   */
  function draftDays() {
    return Array.from(
      new Set([
        ...(rutina?.days ?? []).map((day) => day.day_of_week),
        ...draftSlots.map((slot) => slot.day_of_week),
      ])
    ).sort((a, b) => a - b);
  }

  function reorderDays(activeDay: number, overDay: number) {
    const remap = remapDaysForMove(draftDays(), activeDay, overDay);
    if (!remap) return;

    setOrder(
      [...(order ?? serverSlots)]
        .map((slot) => ({
          ...slot,
          day_of_week: remap.get(slot.day_of_week) ?? slot.day_of_week,
        }))
        // Stable: keeps each day's existing slot order intact.
        .sort((a, b) => a.day_of_week - b.day_of_week)
    );
    setOrderDirty(true);

    // The label lives on the ordinal in skeleton_days, so it has to travel
    // with the day or the subtitles stay behind.
    const serverFocus = new Map(
      (rutina?.days ?? []).map((day) => [day.day_of_week, day.focus])
    );
    setFocusEdits((current) => {
      const next = { ...current };
      for (const [sourceDay, targetDay] of remap) {
        next[targetDay] =
          current[sourceDay] ?? serverFocus.get(sourceDay) ?? '';
      }
      return next;
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId === overId) return;

    if (isDayDragId(activeId)) {
      reorderDays(dayFromDragId(activeId), dayFromDragId(overId));
      return;
    }

    const movingIndex = draftSlots.findIndex((slot) => slot.id === activeId);
    const targetIndex = draftSlots.findIndex((slot) => slot.id === overId);
    if (movingIndex < 0 || targetIndex < 0) return;

    const targetDay = draftSlots[targetIndex].day_of_week;
    const visible = arrayMove(draftSlots, movingIndex, targetIndex).map(
      (slot) =>
        slot.id === activeId ? { ...slot, day_of_week: targetDay } : slot
    );
    const counts = new Map<number, number>();
    for (const slot of visible) {
      counts.set(slot.day_of_week, (counts.get(slot.day_of_week) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > 12)) {
      toast.error('Un día no puede tener más de 12 ejercicios');
      return;
    }
    const visibleIds = new Set(visible.map((slot) => slot.id));
    const hidden = (order ?? serverSlots).filter(
      (slot) => !visibleIds.has(slot.id)
    );
    setOrder([...visible, ...hidden]);
    setOrderDirty(true);
  }

  async function onSave() {
    const addedSlots = (order ?? [])
      .filter((slot) => addedIds.has(slot.id) && !deleted.has(slot.id))
      .map((slot) => ({
        id: slot.id,
        day_of_week: slot.day_of_week,
        exercise_id: slot.exercise_id,
        role: slot.role,
        notes: slot.notes ?? null,
        series: slot.series ?? null,
        reps: slot.reps ?? null,
        descanso: slot.descanso ?? null,
      }));
    const slotOverrides = Object.entries(overrides)
      .filter(([slotId]) => !deleted.has(slotId))
      .map(([slotId, override]) => ({
        slot_id: slotId,
        exercise_id: override.exercise_id,
        notes: override.notes ?? null,
        ...('series' in override
          ? {
              series: override.series ?? null,
              reps: override.reps ?? null,
              descanso: override.descanso ?? null,
            }
          : {}),
      }));
    const perDay = new Map<number, number>();
    const slotOrder = order
      ? order
          .filter((slot) => !deleted.has(slot.id))
          .map((slot) => {
            const slotIndex = (perDay.get(slot.day_of_week) ?? 0) + 1;
            perDay.set(slot.day_of_week, slotIndex);
            return {
              slot_id: slot.id,
              day_of_week: slot.day_of_week,
              slot_index: slotIndex,
            };
          })
      : undefined;
    const payload: ApplyEditsInput = {
      slot_overrides: slotOverrides,
      slot_order: slotOrder,
      deleted_slot_ids: [...deleted],
      added_slots: addedSlots,
      // Blank clears the label server-side. Unchanged labels are dropped so a
      // day reorder (which restages every label) does not send no-op rows.
      day_focus: changedFocus(),
    };

    try {
      await applyEdits.mutateAsync(payload);
      resetDraft();
      toast.success('Cambios guardados');
    } catch (saveError) {
      const status = (saveError as { response?: { status?: number } }).response
        ?.status;
      toast.error(
        status === 409
          ? 'Rutina ya no activa'
          : 'No se pudieron guardar los cambios'
      );
    }
  }

  function onDiscard() {
    if (!window.confirm('¿Descartar todos los cambios sin guardar?')) return;
    resetDraft();
  }

  if (isLoading) {
    return (
      <div className="p-7 text-sm text-muted-foreground">
        Cargando rutina...
      </div>
    );
  }
  if (error || !rutina) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <p>Este atleta aún no tiene rutina activa.</p>
        {pendingSkeletonId && (
          <Link
            to={`/admin/rutinas/${pendingSkeletonId}`}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Ver en cola pendiente <ExternalLink size={12} />
          </Link>
        )}
      </div>
    );
  }

  const slotsByDay = new Map<number, RutinaSlot[]>();
  for (const slot of draftSlots) {
    const daySlots = slotsByDay.get(slot.day_of_week) ?? [];
    daySlots.push(slot);
    slotsByDay.set(slot.day_of_week, daySlots);
  }
  const dayFocus = new Map(
    rutina.days.map((day) => [day.day_of_week, day.focus])
  );
  const days = draftDays();
  const trainedDays = new Set(rutina.trained_days_this_week ?? []);
  const changeCount =
    Object.keys(overrides).filter((id) => !deleted.has(id)).length +
    [...addedIds].filter((id) => !deleted.has(id)).length +
    deleted.size +
    changedFocus().length +
    (orderDirty ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="border-b border-border px-4 py-5 lg:px-7">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{rutina.profile.name}</h1>
            <div className="mt-1 text-xs text-muted-foreground">
              <Link
                to={`/admin/users/${athleteId}`}
                className="inline-flex items-center gap-1 hover:underline"
              >
                Perfil <ExternalLink size={12} />
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {typeof rutina.current_week === 'number' && (
              <>
                <Badge variant="outline" className="shrink-0">
                  Semana {rutina.current_week}
                  {rutina.total_weeks ? ` de ${rutina.total_weeks}` : ''}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWeekOpen(true)}
                  disabled={rutina.has_active_session}
                  title={
                    rutina.has_active_session
                      ? 'Esperá a que termine la sesión abierta'
                      : undefined
                  }
                >
                  Cambiar semana
                </Button>
              </>
            )}
            <Badge variant="outline" className="shrink-0">
              {rutina.profile.days_per_week} días/sem
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDaysOpen(true)}
            >
              Cambiar días
            </Button>
          </div>
        </div>
        {rutina.has_active_session && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <AlertTriangle size={14} />
            Atleta tiene sesión en curso. Los cambios aplicarán en la próxima
            sesión.
          </div>
        )}
        {trainedDays.size > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              El atleta ya entrenó{' '}
              {trainedDays.size === 1 ? 'el día' : 'los días'}{' '}
              {[...trainedDays].sort((a, b) => a - b).join(', ')} de esta
              semana. Si reordenás, esos lugares siguen contando como hechos
              para lo que pase a ocuparlos: mejor reordenar arrancando la
              semana.
            </span>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-6 pb-10 lg:px-7">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={days.map(dayDragId)}
            strategy={verticalListSortingStrategy}
          >
            {days.map((day) => (
              <DayCard
                key={day}
                dayOfWeek={day}
                daysSpecific={rutina.profile.days_specific}
                focus={focusEdits[day] ?? dayFocus.get(day) ?? null}
                slots={slotsByDay.get(day) ?? []}
                trained={trainedDays.has(day)}
                flaggedExerciseIds={flaggedExerciseIds}
                editedSlotIds={editedSlotIds}
                onEdit={onEdit}
                onDelete={onDelete}
                onAdd={onAdd}
                onFocusChange={onFocusChange}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      {hasDraftChanges && (
        <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-4 py-3 lg:px-7">
          <span className="text-sm text-muted-foreground">
            {changeCount} {changeCount === 1 ? 'cambio' : 'cambios'} sin guardar
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onDiscard}
              disabled={applyEdits.isPending}
            >
              Descartar
            </Button>
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={applyEdits.isPending}
            >
              Guardar
            </Button>
          </div>
        </div>
      )}
      <ChangeTrainingDaysDialog
        athleteId={athleteId}
        current={rutina.profile.days_specific}
        open={daysOpen}
        onOpenChange={setDaysOpen}
      />
      {typeof rutina.current_week === 'number' && (
        <SetProgramWeekDialog
          athleteId={athleteId}
          currentWeek={rutina.current_week}
          totalWeeks={rutina.total_weeks ?? rutina.current_week}
          open={weekOpen}
          onOpenChange={setWeekOpen}
        />
      )}
    </div>
  );
}
