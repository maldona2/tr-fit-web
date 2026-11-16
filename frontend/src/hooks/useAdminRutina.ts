import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  ActiveAthleteRow,
  ActiveRutinaResponse,
  ReorderInput,
  SlotCreateInput,
  SlotPatchInput,
  RutinaSlot,
  ApplyEditsInput,
} from '@/types/api';

const KEYS = {
  list: (q?: string) => ['admin', 'rutinas', 'list', q ?? ''] as const,
  detail: (athleteId: string) =>
    ['admin', 'rutinas', 'detail', athleteId] as const,
};

type SlotCreateVariables = SlotCreateInput & {
  exercise_name: string;
  muscle_group: string;
  equipment?: string;
};

export function useActiveAthletes(q?: string) {
  return useQuery({
    queryKey: KEYS.list(q),
    queryFn: async () => {
      const r = await api.get<{ items: ActiveAthleteRow[]; total: number }>(
        '/admin/rutinas/atleta',
        { params: { limit: 200, ...(q ? { q } : {}) } }
      );
      return r.data;
    },
  });
}

export function useActiveRutina(athleteId: string | undefined) {
  return useQuery({
    queryKey: athleteId
      ? KEYS.detail(athleteId)
      : (['admin', 'rutinas', 'detail', 'none'] as const),
    enabled: !!athleteId,
    queryFn: async () => {
      const r = await api.get<ActiveRutinaResponse>(
        `/admin/rutinas/atleta/${athleteId}`
      );
      return r.data;
    },
  });
}

export function useCreateSlot(athleteId: string) {
  const qc = useQueryClient();
  const detailKey = KEYS.detail(athleteId);
  return useMutation({
    mutationFn: async (variables: SlotCreateVariables) => {
      const {
        exercise_name: exerciseName,
        muscle_group: muscleGroup,
        equipment,
        ...input
      } = variables;
      void exerciseName;
      void muscleGroup;
      void equipment;
      const r = await api.post<{ slot: RutinaSlot }>(
        `/admin/rutinas/atleta/${athleteId}/slots`,
        input
      );
      return r.data.slot;
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: detailKey });
      const previous = qc.getQueryData<ActiveRutinaResponse>(detailKey);
      const optimisticId = `optimistic-${Date.now()}-${input.slot_index}`;

      qc.setQueryData<ActiveRutinaResponse>(detailKey, (current) => {
        if (!current?.rutina) return current;
        return {
          ...current,
          rutina: {
            ...current.rutina,
            slots: [
              ...current.rutina.slots,
              {
                id: optimisticId,
                day_of_week: input.day_of_week,
                slot_index: input.slot_index,
                exercise_id: input.exercise_id,
                exercise_name: input.exercise_name,
                muscle_group: input.muscle_group,
                equipment: input.equipment,
                role: input.role,
                notes: input.notes,
              },
            ],
          },
        };
      });

      return { previous, optimisticId };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) qc.setQueryData(detailKey, context.previous);
    },
    onSuccess: (created, _input, context) => {
      qc.setQueryData<ActiveRutinaResponse>(detailKey, (current) => {
        if (!current?.rutina || !context?.optimisticId) return current;
        return {
          ...current,
          rutina: {
            ...current.rutina,
            slots: current.rutina.slots.map((slot) =>
              slot.id === context.optimisticId ? { ...slot, ...created } : slot
            ),
          },
        };
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: detailKey }),
  });
}

export function useUpdateSlot(athleteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { slotId: string; patch: SlotPatchInput }) => {
      const r = await api.patch<{ slot: RutinaSlot }>(
        `/admin/rutinas/slots/${vars.slotId}`,
        vars.patch
      );
      return r.data.slot;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.detail(athleteId) }),
  });
}

export function useDeleteSlot(athleteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (slotId: string) => {
      await api.delete(`/admin/rutinas/slots/${slotId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.detail(athleteId) }),
  });
}

export function useReorderSlots(athleteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReorderInput) => {
      await api.post(`/admin/rutinas/atleta/${athleteId}/reorder`, input);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.detail(athleteId) }),
  });
}

export function useApplyRutinaEdits(athleteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApplyEditsInput) => {
      await api.post(`/admin/rutinas/atleta/${athleteId}/apply-edits`, input);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.detail(athleteId) }),
  });
}

export function useChangeTrainingDays(athleteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (days_specific: string[]) => {
      await api.post(`/admin/rutinas/atleta/${athleteId}/training-days`, {
        days_specific,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.detail(athleteId) }),
  });
}

export function useSetProgramWeek(athleteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (week: number) => {
      await api.post(`/admin/rutinas/atleta/${athleteId}/program-week`, {
        week,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.detail(athleteId) }),
  });
}
