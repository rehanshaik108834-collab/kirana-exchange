"""Base abstract class for all Kirana Exchange demand forecasters."""

from abc import ABC, abstractmethod
from datetime import date

import pandas as pd


class BaseForecaster(ABC):
    """Abstract interface for all demand forecasting models."""

    @abstractmethod
    def fit(self, history_df: pd.DataFrame) -> "BaseForecaster":
        """Fit model on historical panel data.

        `history_df` contains columns:
            [shop_id, product_id, sale_date, qty_sold, stockout_flag]
        """
        pass

    @abstractmethod
    def predict(
        self,
        history_df: pd.DataFrame,
        horizon: int = 7,
        start_date: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        """Generate forecasts for `horizon` days starting at `start_date`.

        If `start_date` is not provided, defaults to max(sale_date) + 1 day.

        Returns DataFrame with columns:
            [shop_id, product_id, forecast_date, predicted_qty]
        where predicted_qty is strictly non-negative (>= 0.0).
        """
        pass
