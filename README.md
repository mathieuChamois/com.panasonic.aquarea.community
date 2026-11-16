Panasonic Aquarea brings your air-to-water heat pump into Homey, letting you monitor temperatures and control your heating zone and hot water tank from a single place. The heat-pump driver connects through the Panasonic Comfort Cloud backend and automatically discovers the compatible Aquarea devices linked to your account.

Comfort Cloud devices whose type is not yet recognized as an Aquarea heat pump (`deviceType` other than `2`), including possible convectors, are also offered during pairing on an experimental basis. Their discovery data and first status response are included in the Homey diagnostics to help add proper support. Until their protocol has been identified, the displayed capabilities may be incomplete and heat-pump control commands should not be used on these devices.

For important setup notes, warnings about API usage, and tips on avoiding account lockouts, please refer to the [Homey Community topic](https://community.homey.app/).

## Flow cards

The app provides Flow cards for the Aquarea-specific capabilities in addition to Homey's standard thermostat cards:

- Conditions for boolean states (DHW tank on/off, circulation pump, defrost, forced hot water, backup heater, bivalent source, electric anode, holiday mode and convector flap).
- Conditions for enum states (current operation, Eco/Comfort preset, quiet mode, powerful mode and fan speed).
- Actions to turn the DHW tank on/off, set the tank setpoint, force hot water, set the heating-zone setpoint (or weather-curve offset) and to control quiet mode, powerful mode, holiday mode, convector fan speed and convector flap.

## Support the project

This app is developed and maintained on a voluntary basis. If it is useful to you, you can support its development through [GitHub Sponsors](https://github.com/sponsors/mathieuChamois).
