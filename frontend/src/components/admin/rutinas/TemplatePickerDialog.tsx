import { useEffect, useMemo, useState } from 'react';
import { Check, Library } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRoutineTemplates } from '@/hooks/useRutina';
import type { RoutineTemplateSummary, RutinaDetail } from '@/types/api';

function label(t: RoutineTemplateSummary) {
  const g = t.gender === 'male' ? 'Hombre' : 'Mujer';
  const legs =
    t.leg_days != null
      ? ` · ${t.leg_days} día${t.leg_days === 1 ? '' : 's'} pierna`
      : '';
  return `${t.days} días · ${g}${legs}`;
}

// Templates that fit the athlete (gender + day count) first.
function score(t: RoutineTemplateSummary, p: RutinaDetail['profile']) {
  const gender = p.gender === 'male' ? 'male' : 'female';
  return (t.gender === gender ? 0 : 2) + (t.days === p.days_per_week ? 0 : 1);
}

export function TemplatePickerDialog({
  open,
  onOpenChange,
  profile,
  current,
  onConfirm,
  submitting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  profile: RutinaDetail['profile'];
  current: string | undefined;
  onConfirm: (source: string) => void;
  submitting: boolean;
}) {
  const { data = [], isLoading } = useRoutineTemplates(open);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (open) setSelected(null);
  }, [open]);

  const sorted = useMemo(
    () => [...data].sort((a, b) => score(a, profile) - score(b, profile)),
    [data, profile]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-brand">
            Rutinas base del entrenador
          </span>
          <DialogTitle>Elegir rutina · {profile.name}</DialogTitle>
          <DialogDescription>
            Reemplaza la rutina propuesta por la que elijas. Los ejercicios que
            el atleta no puede hacer se cambian solos por equivalentes. Se
            pierden los cambios locales sin aprobar.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {isLoading && (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          )}
          {sorted.map((t) => {
            const isSelected = selected === t.source;
            const isCurrent = current === t.source;
            return (
              <button
                key={t.source}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelected(t.source)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                  isSelected
                    ? 'border-brand bg-brand/10'
                    : 'border-border hover:bg-muted/50'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {label(t)}
                    {isCurrent && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        Actual
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {t.source.replace(/\.xlsx$/i, '')}
                  </div>
                </div>
                {isSelected && (
                  <Check size={16} className="mt-0.5 shrink-0 text-brand" />
                )}
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected || submitting}
            className="bg-brand text-primary-foreground hover:bg-brand/90"
          >
            <Library size={14} className="mr-1.5" />
            {submitting ? 'Aplicando…' : 'Usar esta rutina'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
