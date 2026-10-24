import { router } from 'expo-router';
import { useState } from 'react';
import { api, type Ground, type User } from './api';
import { useAuth } from './auth';

export function useFavorite(ground: Pick<Ground, 'id' | 'isFavorite'>) {
  const { user, setUser } = useAuth();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const isFavorite = optimistic ?? (user ? user.favorites.includes(ground.id) : ground.isFavorite);

  async function toggle() {
    if (!user) return router.push('/login');
    const next = !isFavorite;
    setOptimistic(next);
    try {
      setUser(await api<User>(`/me/favorites/${ground.id}`, { method: 'PUT', body: { favorite: next } }));
    } finally {
      setOptimistic(null);
    }
  }

  return { isFavorite, toggle };
}
