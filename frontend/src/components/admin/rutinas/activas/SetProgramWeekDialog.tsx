import { useEffect, useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSetProgramWeek } from '@/hooks/useAdminRutina';

export function SetProgramWeekDialog({
  athleteId,
  currentWeek,
  totalWeeks,
  open,
  onOpenChange,
}: {
  athleteId: string;
  currentWeek: number;
  totalWeeks: number;
  open: boolean;
  onOpenChange: ComponentProps<typeof Dialog>['onOpenChange'];
}) {
  const [week, setWeek] = useState(String(currentWeek));
  const setWeekMutation = useSetProgramWeek(athleteId);
  const weeks = Math.max(totalWeeks, currentWeek, 1);
  useEffect(() => {
    if (open) setWeek(String(currentWeek));
  }, [open, currentWeek]);

  const selected = Number(week);
  const unchanged = selected === currentWeek;

  const submit = async () => {
    try {
      await setWeekMutation.mutateAsync(selected);
      toast.success(
        `Pasa a la semana ${selected}. Al terminarla sigue con la siguiente.`
      );
      onOpenChange(false);
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { error?: string } } })
        .response?.data?.error;
      if (code === 'session_in_progress') {
        toast.error(
          'Tiene una sesión abierta. Cuando la termine, podés cambiar la semana.'
        );
        return;
      }
      toast.error('No se pudo cambiar la semana');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mandar a una semana</DialogTitle>
          <DialogDescription>
            Hoy está en la semana {currentWeek}. Pasa a la que elijas y la
            entrena de nuevo: lo que ya había hecho de esa semana no cuenta.
            Cuando la termina, sigue con la siguiente. Las cargas y el historial
            se conservan.
          </DialogDescription>
        </DialogHeader>
        <Select value={week} onValueChange={setWeek}>
          <SelectTrigger className="w-full" aria-label="Semana del plan">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: weeks }, (_, i) => i + 1).map((n) => (
              <SelectItem key={n} value={String(n)}>
                Semana {n}
                {n === currentWeek ? ' · actual' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={setWeekMutation.isPending}
          >
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={unchanged || setWeekMutation.isPending}
          >
            Mandar a la semana {selected}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
