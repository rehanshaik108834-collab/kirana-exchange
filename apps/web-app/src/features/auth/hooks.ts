import { useMutation } from '@tanstack/react-query';
import { apiClient, ApiProblemError } from '../../lib/api-client';

export interface AuthResponse {
  userId: string;
  role: 'shop_owner' | 'shop_staff' | 'admin';
  accessToken: string;
  refreshToken: string;
}

export interface RegisterInput {
  phone?: string;
  email?: string;
  password: string;
  role?: 'shop_owner' | 'shop_staff';
}

export interface LoginInput {
  phone?: string;
  email?: string;
  password: string;
}

export interface CreateShopInput {
  name: string;
  address: string;
  lat: number;
  lng: number;
  state: string;
  gstScheme: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
  swapRadiusKm?: number;
}

export interface ShopResponse {
  id: string;
  ownerId: string;
  name: string;
  address: string;
  lat: string;
  lng: string;
  state: string;
  gstScheme: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
  swapRadiusKm: string;
  reputationScore: string;
}

function persistSession(data: AuthResponse) {
  localStorage.setItem('accessToken', data.accessToken);
  localStorage.setItem('refreshToken', data.refreshToken);
  localStorage.setItem('userId', data.userId);
  localStorage.setItem('userRole', data.role);
}

export function useRegister() {
  return useMutation<AuthResponse, ApiProblemError, RegisterInput>({
    mutationFn: async (input) => {
      const { data } = await apiClient.post<AuthResponse>('/auth/register', input);
      return data;
    },
    onSuccess: persistSession,
  });
}

export function useLogin() {
  return useMutation<AuthResponse, ApiProblemError, LoginInput>({
    mutationFn: async (input) => {
      const { data } = await apiClient.post<AuthResponse>('/auth/login', input);
      return data;
    },
    onSuccess: persistSession,
  });
}

export function useCreateShop() {
  return useMutation<ShopResponse, ApiProblemError, CreateShopInput>({
    mutationFn: async (input) => {
      const { data } = await apiClient.post<ShopResponse>('/shops', input);
      return data;
    },
  });
}
