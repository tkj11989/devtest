import { useEffect, useState } from 'react';
import { api } from './api';

export type OwnerGround = { id: string; name: string; area: string; sportId: string; type: string };

export function useOwnerGrounds() {
  const [grounds, setGrounds] = useState<OwnerGround[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<OwnerGround[]>('/owner/grounds').then(setGrounds, (e) => setError(e.message));
  }, []);
  return { grounds, error };
}
