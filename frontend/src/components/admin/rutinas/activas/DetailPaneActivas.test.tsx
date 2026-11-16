import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { DetailPaneActivas } from './DetailPaneActivas';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const rutinaResponse = {
  rutina: {
    profile: {
      user_id: 'athlete-1',
      name: 'Test Athlete',
      days_per_week: 2,
      days_specific: ['lun', 'mar'],
    },
    skeleton: {
      id: 'skeleton-1',
      athlete_id: 'athlete-1',
      status: 'approved',
      created_at: '2026-07-14T00:00:00Z',
      reviewed_at: '2026-07-14T00:00:00Z',
    },
    days: [
      { day_of_week: 1, focus: 'pecho' },
      { day_of_week: 2, focus: 'espalda' },
    ],
    slots: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        day_of_week: 1,
        slot_index: 1,
        exercise_id: 1,
        role: 'principal',
        notes: null,
        exercise_name: 'Press Banca',
        muscle_group: 'Pecho - Mayor',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        day_of_week: 1,
        slot_index: 2,
        exercise_id: 2,
        role: 'accesorio',
        notes: null,
        series: 2,
        reps: '10x10x10',
        descanso: '2 min',
        exercise_name: 'Aperturas',
        muscle_group: 'Pecho - Mayor',
      },
    ],
    has_active_session: false,
  },
  pending_skeleton_id: null,
};

function renderPane() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter>
          <DetailPaneActivas athleteId="athlete-1" />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.startsWith('/admin/rutinas/atleta/')) {
      return { data: rutinaResponse };
    }
    return { data: { items: [] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});

describe('DetailPaneActivas program week', () => {
  it('shows the current week and blocks the change while a session is open', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.startsWith('/admin/rutinas/atleta/')) {
        return {
          data: {
            ...rutinaResponse,
            rutina: {
              ...rutinaResponse.rutina,
              current_week: 9,
              total_weeks: 30,
              has_active_session: true,
            },
          },
        };
      }
      return { data: { items: [] } };
    });
    renderPane();
    expect(await screen.findByText('Semana 9 de 30')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cambiar semana' })
    ).toBeDisabled();
  });
});

describe('DetailPaneActivas draft save', () => {
  it('does not show save bar without changes', async () => {
    renderPane();
    await screen.findByText('Press Banca');
    expect(screen.queryByText(/sin guardar/)).not.toBeInTheDocument();
  });

  it('stages deletion and sends one batched save request', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText('Press Banca');

    await user.click(screen.getAllByRole('button', { name: 'Editar slot' })[1]);
    await user.click(screen.getByRole('button', { name: /eliminar/i }));

    expect(screen.queryByText('Aperturas')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();

    expect(screen.getByText(/sin guardar/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [url, body] = vi.mocked(api.post).mock.calls[0];
    expect(url).toBe('/admin/rutinas/atleta/athlete-1/apply-edits');
    expect(body).toMatchObject({
      deleted_slot_ids: ['22222222-2222-4222-8222-222222222222'],
    });
  });

  it('stages a renamed muscle group and sends it on save', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText('Press Banca');

    const input = screen.getByLabelText('Grupos musculares del día 1');
    await user.clear(input);
    await user.type(input, 'Espalda');

    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.post).mock.calls[0];
    expect(body).toMatchObject({
      day_focus: [{ day_of_week: 1, focus: 'Espalda' }],
    });
  });

  it('discard restores server state without network calls', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText('Press Banca');

    await user.click(screen.getAllByRole('button', { name: 'Editar slot' })[1]);
    await user.click(screen.getByRole('button', { name: /eliminar/i }));
    expect(screen.queryByText('Aperturas')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(await screen.findByText('Aperturas')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('adds a principal lift following the current week, not a fixed accessory scheme', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.startsWith('/admin/rutinas/atleta/')) {
        return { data: rutinaResponse };
      }
      if (url.startsWith('/exercises') || url.startsWith('/admin/exercises')) {
        return {
          data: {
            items: [
              {
                id: 10,
                name: 'Press Plano con Barra',
                muscle_group: 'Pecho - Mayor',
                equipment: 'barra',
                is_principal: true,
              },
            ],
            total: 1,
          },
        };
      }
      return { data: { items: [] } };
    });

    const user = userEvent.setup();
    renderPane();
    await screen.findByText('Press Banca');

    await user.click(
      screen.getAllByRole('button', { name: /agregar ejercicio/i })[0]
    );
    await user.click(await screen.findByText('Press Plano con Barra'));

    const roleSelect = await screen.findByLabelText('Rol en la rutina');
    expect(roleSelect).toHaveValue('principal');
    await user.click(screen.getByRole('button', { name: 'Agregar' }));

    expect(screen.getByText('Press Plano con Barra')).toBeInTheDocument();
    expect(screen.getAllByText('principal')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.post).mock.calls[0];
    expect(body).toMatchObject({
      added_slots: [
        expect.objectContaining({
          exercise_id: 10,
          role: 'principal',
          series: null,
          reps: null,
          descanso: null,
        }),
      ],
    });
  });
});
