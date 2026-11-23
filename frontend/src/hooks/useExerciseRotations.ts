import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ExerciseRotation {
  id: string;
  created_at: string;
  program_week: number;
  day_of_week: number;
  muscle_group: string;
  from_exercise_id: number;
  from_name: string;
  to_exercise_id: number;
  to_name: string;
}

// Coach view of the automatic accessory swaps (one every 2 program weeks).
export function useExerciseRotations(userId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'exercise-rotations', userId],
    enabled: !!userId,
    queryFn: async (): Promise<ExerciseRotation[]> => {
      const r = await api.get<ExerciseRotation[]>(
        `/admin/users/${userId}/rotations`
      );
      return r.data;
    },
    staleTime: 30_000,
  });
}

// Coach switch: freeze the automatic rotation (e.g. ACL rehab).
export function useRotationLock(userId: string) {
  const qc = useQueryClient();
  const key = ['admin', 'rotation-lock', userId];
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<boolean> => {
      const r = await api.get<{ locked: boolean }>(
        `/admin/users/${userId}/rotation-lock`
      );
      return r.data.locked;
    },
  });
  const mutation = useMutation({
    mutationFn: async (locked: boolean): Promise<boolean> => {
      const r = await api.put<{ locked: boolean }>(
        `/admin/users/${userId}/rotation-lock`,
        { locked }
      );
      return r.data.locked;
    },
    onSuccess: (locked) => qc.setQueryData(key, locked),
  });
  return { query, mutation };
}
